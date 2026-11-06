import { describe, expect, it } from 'vitest';
import {
  admitLate, buildLeagueBoards, divisionTable, finalizeLeague, leagueProblems, leagueRewardFor, leagueTick, newLeague, pairDivision,
  seasonStartMs, teamLeagueView, weekWindows, LEAGUE_BOARD_RE, type LeagueConfig, type LeagueState,
} from '../src/domain/league.js';
import { closeSeasonStep, newTeam, playerTeamReward, seasonEndMs, type TeamSummary } from '../src/domain/teams.js';
import { resolveBundle } from '../src/ops/config.js';
import { CRONS, runScheduled } from '../src/domain/scheduled.js';
import { handle, teamPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DAY_MS } from '../src/domain/time.js';
import { freshPlayer, m } from './helpers.js';

const cfg: LeagueConfig = m.progression.league;
const SEASON = '2026-11';
const START = seasonStartMs(SEASON);
const HOUR = 3_600_000;

const team = (teamId: string, points: number, members = 5, season = SEASON): TeamSummary =>
  ({ teamId, name: `支部${teamId}`, joinPolicy: 'open', members, points, season, updatedAt: 0 });

/** Ticks the league with the given summaries at `now`. */
function tick(st: LeagueState, teams: TeamSummary[], now: number, c: LeagueConfig = cfg) { return leagueTick(st, c, teams, now); }

describe('league: windows and setup (REQ-LEAGUE-001)', () => {
  it('cuts the JST month into weekly windows, the last one running to month end', () => {
    const w = weekWindows(SEASON, 4);
    expect(w).toHaveLength(4);
    expect(new Date(w[0]!.startMs).toISOString()).toBe('2026-10-31T15:00:00.000Z'); // 11/1 00:00 JST
    expect(w[1]!.startMs - w[0]!.startMs).toBe(7 * DAY_MS);
    expect(w[3]!.endMs).toBe(seasonEndMs(SEASON));
    for (let i = 1; i < w.length; i++) expect(w[i]!.startMs).toBe(w[i - 1]!.endMs);
  });

  it('starts from last season\'s divisions, dropping unknown ones; new teams start in the lowest division', () => {
    const st = newLeague(SEASON, cfg, { a: 's1', b: 'nope' });
    expect(st.divisionOf).toEqual({ a: 's1' });
    tick(st, [team('a', 0), team('b', 0)], START + HOUR);
    expect(st.divisionOf).toEqual({ a: 's1', b: 's3' });
    expect(st.weeks[0]!.status).toBe('open');
  });

  it('the shipped config is valid and bad configs are refused (boot and remote config)', () => {
    expect(leagueProblems(cfg)).toEqual([]);
    expect(leagueProblems({ ...cfg, divisions: [] }).join()).toMatch(/non-empty/);
    expect(leagueProblems({ ...cfg, divisions: [{ id: 's1', name: 'a' }, { id: 's1', name: 'b' }] }).join()).toMatch(/duplicate/);
    expect(leagueProblems({ ...cfg, winPoints: 1, drawPoints: 1 }).join()).toMatch(/winPoints > drawPoints/);
    expect(leagueProblems({ ...cfg, weeks: 9 }).join()).toMatch(/weeks/);
    expect(leagueProblems({ ...cfg, rewards: [{ divisionId: 'x', maxPlace: 1, reward: { freeCoins: 1 } }] }).join()).toMatch(/unknown division/);
    expect(leagueProblems({ ...cfg, rewards: [{ divisionId: 's1', maxPlace: 1, reward: { items: [{ itemId: 'nope', qty: 1 }] } }] }, new Set(['x'])).join()).toMatch(/unknown item/);
    expect(() => resolveBundle(m, { progression: { league: { ...cfg, byePoints: 99 } } } as never)).toThrow(/byePoints/);
    expect(resolveBundle(m, { progression: { league: { ...cfg, weeks: 3 } } } as never).master.progression.league.weeks).toBe(3);
  });
});

describe('league: pairing by points band (REQ-LEAGUE-002)', () => {
  it('pairs neighbours by season points in week 1 and gives the odd team out a bye', () => {
    const st = newLeague(SEASON, cfg, {});
    tick(st, [team('a', 10), team('b', 500), team('c', 40), team('d', 300), team('e', 0)], START + HOUR);
    const ms = st.weeks[0]!.matches['s3']!;
    expect(ms.map((x) => [x.a, x.b])).toEqual([['b', 'd'], ['c', 'a'], ['e', null]]);
    expect(ms[0]!.aStart).toBe(500);
  });

  it('teams with too few members sit the week out; teams of other seasons are ignored', () => {
    const st = newLeague(SEASON, cfg, {});
    tick(st, [team('a', 10), team('b', 20), team('small', 30, cfg.minMembers - 1), team('old', 40, 9, '2026-10')], START + HOUR);
    expect(st.weeks[0]!.matches['s3']!.map((x) => [x.a, x.b])).toEqual([['b', 'a']]);
  });

  it('avoids last week\'s opponent when a swap is possible', () => {
    const st = newLeague(SEASON, cfg, {});
    const ts = [team('a', 0), team('b', 0), team('c', 0), team('d', 0)];
    tick(st, ts, START + HOUR); // a-b, c-d
    expect(st.weeks[0]!.matches['s3']!.map((x) => [x.a, x.b])).toEqual([['a', 'b'], ['c', 'd']]);
    // nobody scores: all draw, standings level, so the natural order would repeat a-b
    tick(st, ts, st.weeks[1]!.startMs + HOUR);
    expect(st.weeks[0]!.status).toBe('scored');
    const w2 = st.weeks[1]!.matches['s3']!.map((x) => [x.a, x.b]);
    expect(w2).toEqual([['a', 'c'], ['b', 'd']]);
    expect(pairDivision(st, 's3', ts, 1).map((x) => [x.a, x.b])).toEqual(w2); // deterministic
  });

  it('admits late teams (no member had raced yet) into the bye slot, then against each other, within lateEntryHours', () => {
    const st = newLeague(SEASON, cfg, {});
    tick(st, [team('a', 0), team('b', 0), team('c', 0)], START + HOUR); // a-b, c bye
    expect(admitLate(st, cfg, 0, [team('a', 0), team('b', 0), team('c', 0)])).toBe(false);
    tick(st, [team('a', 0), team('b', 0), team('c', 0), team('x', 30), team('y', 5), team('z', 0)], START + 3 * HOUR);
    const ms = st.weeks[0]!.matches['s3']!;
    expect(ms.map((x) => [x.a, x.b])).toEqual([['a', 'b'], ['c', 'x'], ['y', 'z']]);
    // late teams start from 0: growth before they appeared counts (their season points only exist since then)
    expect(ms[1]!.bStart).toBe(0);
    // too late: a team appearing after lateEntryHours waits for next week
    tick(st, [team('a', 0), team('b', 0), team('c', 0), team('x', 30), team('y', 5), team('z', 0), team('w', 0)], START + (cfg.lateEntryHours + 1) * HOUR);
    expect(ms.some((x) => x.a === 'w' || x.b === 'w')).toBe(false);
  });
});

describe('league: scoring, promotion and rewards (REQ-LEAGUE-003/004)', () => {
  /** Two divisions of four teams, one full season where points grow by `growth[team]` every week. */
  function season(growth: Record<string, number>, carry: Record<string, string>) {
    const st = newLeague(SEASON, cfg, carry);
    const pts: Record<string, number> = Object.fromEntries(Object.keys(growth).map((k) => [k, 0]));
    const snap = () => Object.keys(growth).map((k) => team(k, pts[k]!));
    for (const w of st.weeks) {
      tick(st, snap(), w.startMs + HOUR);
      for (const k of Object.keys(growth)) pts[k]! += growth[k]!;
      tick(st, snap(), w.endMs - HOUR); // nothing changes until the window ends
    }
    const end = seasonEndMs(SEASON);
    const fin = finalizeLeague(st, cfg, snap(), end);
    return { st, fin, snap };
  }

  it('scores each window from season points growth; win 3 / draw 1 / loss 0; ends with promotion and relegation', () => {
    const carry = { a1: 's1', a2: 's1', a3: 's1', a4: 's1', b1: 's2', b2: 's2', b3: 's2', b4: 's2' };
    const { st, fin } = season({ a1: 40, a2: 30, a3: 20, a4: 10, b1: 90, b2: 80, b3: 5, b4: 1 }, carry);
    const s1 = divisionTable(st, 's1');
    expect(s1.map((r) => r.teamId)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(s1[0]!.won).toBe(4);
    expect(s1[0]!.leaguePoints).toBe(4 * cfg.winPoints);
    expect(s1.reduce((n, r) => n + r.played, 0)).toBe(4 * 4); // everyone played every week
    expect(st.weeks.every((w) => w.status === 'scored')).toBe(true);
    // places, promotion (top 2 of s2) and relegation (bottom 2 of s1 and of s2)
    expect(fin.places.a1).toEqual({ divisionId: 's1', place: 1, size: 4 });
    expect(fin.places.b1!.place).toBe(1);
    expect(fin.next).toMatchObject({ a1: 's1', a2: 's1', a3: 's2', a4: 's2', b1: 's1', b2: 's1', b3: 's3', b4: 's3' }); // s2 is not the lowest division
    // final is fixed; later ticks change nothing
    expect(finalizeLeague(st, cfg, [], 0)).toBe(fin);
    expect(tick(st, [], seasonEndMs(SEASON) + DAY_MS)).toBe(false);
    // rewards by division and place
    expect(leagueRewardFor(cfg, fin.places.a1)).toEqual(cfg.rewards.find((b) => b.divisionId === 's1' && b.maxPlace === 1)!.reward);
    expect(leagueRewardFor(cfg, fin.places.b4)).toEqual(cfg.rewards.find((b) => b.divisionId === 's2' && b.maxPlace === null)!.reward);
    expect(leagueRewardFor(cfg, null)).toBeNull();
  });

  it('a window the cron missed entirely is skipped, not scored late', () => {
    const st = newLeague(SEASON, cfg, {});
    tick(st, [team('a', 0), team('b', 0)], st.weeks[1]!.startMs + HOUR);
    expect(st.weeks.map((w) => w.status)).toEqual(['skipped', 'open', 'pending', 'pending']);
  });

  it('byes earn byePoints, not a win; a lone team in a division plays nobody', () => {
    const st = newLeague(SEASON, cfg, { solo: 's1' });
    tick(st, [team('solo', 0)], START + HOUR);
    tick(st, [team('solo', 50)], st.weeks[1]!.startMs);
    expect(st.table.solo).toMatchObject({ byes: 1, played: 0, leaguePoints: cfg.byePoints, won: 0 });
  });

  it('the league reward is paid with the team season reward, once, to members who meet the tenure rule', async () => {
    const end = seasonEndMs(SEASON);
    const t = newTeam('tleague01', 'リーグ支部', { playerId: 'early', displayName: 'E', season: SEASON, points: 0 }, 'open', '', end - 30 * DAY_MS);
    t.members.push({ playerId: 'late', displayName: 'L', role: 'member', joinedAt: end - DAY_MS, baselineSeason: SEASON, baselinePoints: 0, season: SEASON, points: 0 });
    const place = { divisionId: 's2', place: 1, size: 6 };
    const paid: string[] = [];
    // a team with no season points gets no team reward, but its league place still pays (REQ-LEAGUE-004)
    const c = await closeSeasonStep(t, m.progression.teams, SEASON, null, 0, async (pid, close) => { paid.push(`${pid}:${close.league?.place}`); }, 10, async () => undefined, { cfg, place });
    expect(c.done).toBe(true);
    expect(paid).toEqual(['early:1']); // `late` joined less than rewardMinDays before the end
    const p = freshPlayer('early');
    const before = p.wallet.free;
    const r1 = playerTeamReward(p, m.progression.teams, SEASON, t.id, null, 0, end, { cfg, place });
    expect(r1).toMatchObject({ status: 'rewarded', reward: null, leagueReward: leagueRewardFor(cfg, place) });
    expect(p.wallet.free - before).toBe(leagueRewardFor(cfg, place)!.freeCoins);
    expect(playerTeamReward(p, m.progression.teams, SEASON, t.id, null, 0, end, { cfg, place }).status).toBe('already');
    expect(p.wallet.free - before).toBe(leagueRewardFor(cfg, place)!.freeCoins);
    // no team reward and no league place: nobody is listed for payout
    const t2 = newTeam('tleague02', 'x', { playerId: 'e2', displayName: 'E', season: SEASON, points: 0 }, 'open', '', end - 30 * DAY_MS);
    expect((await closeSeasonStep(t2, m.progression.teams, SEASON, null, 0, async () => undefined, 10, async () => undefined, { cfg, place: null })).eligible).toEqual([]);
  });
});

describe('league: views (REQ-LEAGUE-005)', () => {
  it('publishes one board per division and a per-team view with matchups and final place', () => {
    const st = newLeague(SEASON, cfg, {});
    tick(st, [team('a', 0), team('b', 0), team('c', 0)], START + HOUR);
    tick(st, [team('a', 30), team('b', 10), team('c', 99)], st.weeks[1]!.startMs + HOUR);
    const boards = buildLeagueBoards(st, cfg, st.weeks[1]!.startMs + HOUR);
    expect(boards.map((b) => b.board)).toEqual(['league-s1', 'league-s2', 'league-s3']);
    for (const b of boards) expect(LEAGUE_BOARD_RE.test(b.board)).toBe(true);
    const s3 = boards[2]!;
    expect(s3.entries[0]).toMatchObject({ teamId: 'a', place: 1, won: 1 });
    expect(s3.currentWeek).toBe(1);
    const v = teamLeagueView(st, cfg, 'a', st.weeks[1]!.startMs + HOUR);
    expect(v).toMatchObject({ seasonId: SEASON, divisionId: 's3', divisionName: '三部', place: 1, final: null });
    expect(v.matches[0]).toMatchObject({ opponent: 'b', opponentName: '支部b', myScore: 30, opponentScore: 10, bye: false, status: 'scored' });
    expect(teamLeagueView(st, cfg, 'c', 0).matches[0]).toMatchObject({ bye: true, opponent: null });
    finalizeLeague(st, cfg, [team('a', 30), team('b', 10), team('c', 99)], seasonEndMs(SEASON));
    expect(teamLeagueView(st, cfg, 'a', seasonEndMs(SEASON)).final).toMatchObject({ divisionId: 's3', place: 1, nextDivisionId: 's2', reward: leagueRewardFor(cfg, { divisionId: 's3', place: 1, size: 3 }) });
    expect(teamLeagueView(null, cfg, 'a', 0)).toMatchObject({ seasonId: null, table: [], matches: [] });
  });

  it('HTTP: GET /v1/league/me and the league-<division> leaderboard boards', async () => {
    const NOW = Date.UTC(2026, 10, 5, 3);
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const teams = new MemoryTeams(() => m, () => NOW);
    const c = {
      master: m, player: () => invoker, clock: () => NOW,
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      leaderboard: { board: async (season: string, board: string) => ({ season, board }), myRank: async () => null },
      teams: new TeamsService(() => m, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(1), () => NOW),
    } as unknown as AppContext;
    const call = async (method: string, path: string, user?: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/league/me', 'solo')).body).toMatchObject({ teamId: null, season: SEASON, divisionId: null, divisions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
    const teamId = (await call('POST', '/v1/teams', 'lead', { name: 'リーグRC', joinPolicy: 'open' })).body.teamId as string;
    for (const u of ['a', 'b']) await call('POST', `/v1/teams/${teamId}/join`, u);
    const other = (await call('POST', '/v1/teams', 'lead2', { name: '対戦RC', joinPolicy: 'open' })).body.teamId as string;
    for (const u of ['c', 'd']) await call('POST', `/v1/teams/${other}/join`, u);
    teams.leagueStep(SEASON, NOW);
    const me = (await call('GET', '/v1/league/me', 'a')).body;
    expect(me).toMatchObject({ teamId, season: SEASON, divisionId: 's3', divisionName: '三部' });
    const cur = me.matches.find((x: any) => x.status === 'open');
    expect(cur.opponent).toBe(other);
    expect((await call('GET', '/v1/leaderboards/current/league-s1')).body).toEqual({ season: SEASON, board: 'league-s1' });
    expect((await call('GET', '/v1/leaderboards/current/league-S1')).status).toBe(400);
  });

  it('the cron runs the current season\'s league after the past seasons\' rollovers (which finalize last month)', async () => {
    const order: string[] = [];
    const done = await runScheduled(CRONS.frequent, Date.UTC(2026, 11, 3, 3), {
      snapshot: async () => undefined,
      rolloverStep: async (s) => { order.push(`roll:${s}`); return { status: 'closed' }; },
      teamRolloverStep: async (s) => { order.push(`team:${s}`); return { status: 'closed' }; },
      leagueStep: async (s) => { order.push(`league:${s}`); return { status: 'week1' }; },
      sweepReplays: async () => ({ deleted: 0 }),
    });
    expect(order.at(-1)).toBe('league:2026-12');
    expect(order.indexOf('team:2026-11')).toBeLessThan(order.indexOf('league:2026-12'));
    expect(done).toContain('league:week1');
  });
});
