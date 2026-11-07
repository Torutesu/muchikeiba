import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryTeams, TeamsService, newTeamId, type TeamPlayers } from '../src/domain/teamService.js';
import {
  buildTeamBoard, closeSeasonStep, contribution, eligibleMembers, newTeam, playerTeamReward, seasonEndMs, teamRewardFor,
  validateAnnouncement, validateTeamName, type TeamState,
} from '../src/domain/teams.js';
import type { PlayerState } from '../src/domain/player.js';
import { DAY_MS } from '../src/domain/time.js';
import { freshPlayer, m } from './helpers.js';

const cfg = m.progression.teams;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function world(start = Date.UTC(2026, 10, 5, 3)) {
  let t = start;
  const clock = () => t;
  const repo = new MemoryPlayerRepo();
  const teams = new MemoryTeams(() => m, clock);
  const reports: { teamId: string; playerId: string; points: number }[] = [];
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(5), clock, verifiers: {},
    onTeamPoints: async (p) => { reports.push(p); await teams.reportPoints(p.teamId, p.playerId, p.seasonId, p.points, p.displayName); },
  });
  const players: TeamPlayers = {
    prepareJoin: (u, x) => svc.teamPrepareJoin(u, x), commitJoin: (u, x) => svc.teamCommitJoin(u, x), abortJoin: (u, x) => svc.teamAbortJoin(u, x),
    addOutgoing: (u, x) => svc.teamAddOutgoing(u, x), removeOutgoing: (u, x) => svc.teamRemoveOutgoing(u, x),
    left: (u, x, c) => svc.teamLeft(u, x, c), state: (u) => svc.teamState(u), push: (u, id, v) => svc.queuePush(u, id, v),
    stampCatalog: (u) => svc.stampCatalog(u), stampCheck: (u, s) => svc.stampCheck(u, s), stampPosted: (u, s, k, t) => svc.stampPosted(u, s, k, t),
    feedViewer: (u, f) => svc.feedViewer(u, f), feedMutes: (u) => svc.feedMutes(u), feedMute: (u, t, x) => svc.feedMute(u, t, x),
    feedReported: (u, t, q, b, r) => svc.feedReported(u, t, q, b, r), cheerPush: (u, f, n) => svc.cheerPush(u, f, n),
  };
  const ts = new TeamsService(() => m, teams, players, teams, teams, seededRng(77), clock);
  const state = async (u: string) => (await repo.get(u)) as PlayerState;
  const setPoints = async (u: string, points: number) => {
    const s = await state(u);
    s.season.points = points;
    s.season.races = Math.max(1, s.season.races);
    repo.put(s);
  };
  return { svc, repo, teams, ts, reports, state, setPoints, advance: (ms: number) => { t += ms; }, now: clock };
}

async function boot(w: ReturnType<typeof world>, ...ids: string[]) {
  for (const id of ids) await w.svc.bootstrap(id);
}

describe('team names and announcements (REQ-TEAM-001/006)', () => {
  it('validates length, NG words and URLs', () => {
    expect(validateTeamName(m, '  青葉  ライダーズ ')).toBe('青葉 ライダーズ');
    expect(() => validateTeamName(m, 'あ')).toThrow(/2〜12/);
    expect(() => validateTeamName(m, 'あいうえおかきくけこさしす')).toThrow(/2〜12/);
    expect(() => validateTeamName(m, 'see x.com')).toThrow(/URL/);
    const ng = m.ng.contains[0] ?? m.ng.exact[0]!;
    expect(() => validateTeamName(m, `${ng}団`)).toThrow();
    expect(validateAnnouncement(m, cfg, '毎晩21時に集合\n初心者歓迎')).toBe('毎晩21時に集合\n初心者歓迎');
    expect(() => validateAnnouncement(m, cfg, 'x'.repeat(cfg.announcementMax + 1))).toThrow(/longer/);
    expect(() => validateAnnouncement(m, cfg, 'join https://evil')).toThrow(/URL/);
  });
});

describe('create / join / leave (REQ-TEAM-001/002/004/007)', () => {
  it('open teams are joined directly; one team per player; the leader is the creator', async () => {
    const w = world();
    await boot(w, 'lead', 'a', 'b');
    const v = await w.ts.create('lead', 'あおばRC', 'open', 'よろしく');
    expect(v.members).toEqual([expect.objectContaining({ playerId: 'lead', role: 'leader' })]);
    expect((await w.ts.join('a', v.teamId)).status).toBe('joined');
    expect((await w.ts.me('a')).team?.members.map((x) => x.playerId).sort()).toEqual(['a', 'lead']);
    const other = await w.ts.create('b', 'みなと会', 'open', '');
    expect(await code(w.ts.join('a', other.teamId))).toBe('ALREADY_IN_TEAM');
    expect(await code(w.ts.create('a', '三つ目', 'open', ''))).toBe('ALREADY_IN_TEAM');
  });

  it('a full team refuses and leaves the player untouched (no half-join)', async () => {
    const w = world();
    const ids = Array.from({ length: cfg.maxMembers + 1 }, (_, i) => `p${i}`);
    await boot(w, ...ids);
    const v = await w.ts.create('p0', '満員テスト', 'open', '');
    for (const id of ids.slice(1, cfg.maxMembers)) await w.ts.join(id, v.teamId);
    const last = ids[cfg.maxMembers]!;
    expect(await code(w.ts.join(last, v.teamId))).toBe('TEAM_FULL');
    expect((await w.svc.teamState(last)).teamId).toBeNull();
    // the failed join released its lock: the player can join another team right away
    const v2 = await w.ts.create('x', 'ほか', 'open', '').catch(async () => { await w.svc.bootstrap('x'); return w.ts.create('x', 'ほか', 'open', ''); });
    expect((await w.ts.join(last, v2.teamId)).status).toBe('joined');
  });

  it('leaving starts the rejoin cooldown; being kicked does not', async () => {
    const w = world();
    await boot(w, 'lead', 'a', 'b');
    const v = await w.ts.create('lead', 'クールダウン', 'open', '');
    await w.ts.join('a', v.teamId);
    await w.ts.join('b', v.teamId);
    await w.ts.leave('a');
    expect(await code(w.ts.join('a', v.teamId))).toBe('TEAM_COOLDOWN');
    w.advance(cfg.rejoinCooldownMs);
    expect((await w.ts.join('a', v.teamId)).status).toBe('joined');
    await w.ts.kick('lead', 'b');
    expect((await w.svc.teamState('b')).teamId).toBeNull();
    expect((await w.ts.join('b', v.teamId)).status).toBe('joined'); // no cooldown after a kick
  });

  it('the leader must transfer before leaving; a lone leader leaving or disbanding ends the team', async () => {
    const w = world();
    await boot(w, 'lead', 'a');
    const v = await w.ts.create('lead', '解散テスト', 'open', '');
    await w.ts.join('a', v.teamId);
    expect(await code(w.ts.leave('lead'))).toBe('TEAM_LEADER_MUST_TRANSFER');
    expect(await code(w.ts.disband('lead'))).toBe('FORBIDDEN');
    await w.ts.transfer('lead', 'a');
    const after = await w.ts.view(v.teamId, 'a');
    expect(after.members.find((x) => x.playerId === 'a')?.role).toBe('leader');
    expect(after.members.find((x) => x.playerId === 'lead')?.role).toBe('officer');
    await w.ts.leave('lead');
    await w.ts.disband('a');
    expect((await w.ts.view(v.teamId, null)).disbanded).toBe(true);
    expect((await w.svc.teamState('a')).teamId).toBeNull();
    expect(await w.ts.search('解散')).toEqual([]);
  });
});

describe('approval policy and roles (REQ-TEAM-002/003)', () => {
  it('requests notify managers; officers approve; approval pushes to the applicant', async () => {
    const w = world();
    await boot(w, 'lead', 'off', 'app', 'mem');
    await w.svc.registerDevice('lead', 'tok-lead-123456', 'ios');
    await w.svc.registerDevice('app', 'tok-app-1234567', 'android');
    const v = await w.ts.create('lead', '承認制', 'approval', '');
    expect(await code(w.ts.join('mem', v.teamId).then(() => w.ts.approve('lead', 'mem')))).toBe('ok');
    expect(await code(w.ts.join('off', v.teamId))).toBe('ok');
    await w.ts.approve('lead', 'off');
    await w.ts.setRole('lead', 'off', 'officer');
    expect((await w.ts.join('app', v.teamId)).status).toBe('requested');
    expect((await w.state('lead')).push!.outbox.some((o) => o.templateId === 'team_request')).toBe(true);
    expect(await code(w.ts.approve('mem', 'app'))).toBe('FORBIDDEN'); // plain members cannot approve
    await w.ts.approve('off', 'app');
    expect((await w.svc.teamState('app')).teamId).toBe(v.teamId);
    expect((await w.state('app')).push!.outbox.some((o) => o.templateId === 'team_approved')).toBe(true);
    // officers can kick members but not other officers or the leader
    expect(await code(w.ts.kick('off', 'lead'))).toBe('FORBIDDEN');
    await w.ts.setRole('lead', 'mem', 'officer');
    expect(await code(w.ts.kick('off', 'mem'))).toBe('FORBIDDEN');
    expect(await code(w.ts.kick('off', 'app'))).toBe('ok');
  });

  it('a request is dropped when the applicant joined another team meanwhile', async () => {
    const w = world();
    await boot(w, 'l1', 'l2', 'app');
    const a = await w.ts.create('l1', '承認A', 'approval', '');
    const b = await w.ts.create('l2', '自由B', 'open', '');
    await w.ts.join('app', a.teamId);
    await w.ts.join('app', b.teamId);
    expect(await code(w.ts.approve('l1', 'app'))).toBe('ALREADY_IN_TEAM');
    expect((await w.ts.view(a.teamId, 'l1')).requests).toEqual([]);
  });

  it('caps outgoing requests and officers; decline removes the request on both sides', async () => {
    const w = world();
    const leaders = Array.from({ length: cfg.maxOutgoingRequests + 1 }, (_, i) => `l${i}`);
    await boot(w, 'app', ...leaders);
    const teams = [];
    for (const l of leaders) teams.push(await w.ts.create(l, `承認${l}`, 'approval', ''));
    for (const t of teams.slice(0, cfg.maxOutgoingRequests)) await w.ts.join('app', t.teamId);
    expect(await code(w.ts.join('app', teams[cfg.maxOutgoingRequests]!.teamId))).toBe('TEAM_LIMIT');
    await w.ts.decline('l0', 'app');
    expect((await w.svc.teamState('app')).outgoing).not.toContain(teams[0]!.teamId);
    expect((await w.ts.view(teams[0]!.teamId, 'l0')).requests).toEqual([]);

    const w2 = world();
    const ids = ['lead', ...Array.from({ length: cfg.maxOfficers + 1 }, (_, i) => `o${i}`)];
    await boot(w2, ...ids);
    const v = await w2.ts.create('lead', '役職', 'open', '');
    for (const id of ids.slice(1)) await w2.ts.join(id, v.teamId);
    for (const id of ids.slice(1, cfg.maxOfficers + 1)) await w2.ts.setRole('lead', id, 'officer');
    expect(await code(w2.ts.setRole('lead', ids[cfg.maxOfficers + 1]!, 'officer'))).toBe('TEAM_LIMIT');
  });
});

describe('team points (REQ-TEAM-005)', () => {
  it('only points earned after joining count, capped per member; the hook reports standing changes', async () => {
    const w = world();
    await boot(w, 'lead', 'star');
    await w.setPoints('star', 300); // points before joining are not credited
    const v = await w.ts.create('lead', 'ポイント', 'open', '');
    await w.ts.join('star', v.teamId);
    expect((await w.ts.view(v.teamId, null)).points).toBe(0);
    await w.svc.applyRace('star', { raceId: 'r1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false });
    expect(w.reports.at(-1)).toMatchObject({ teamId: v.teamId, playerId: 'star' });
    const gained = m.progression.seasonPointsByPlace[0]!;
    expect((await w.ts.view(v.teamId, null)).points).toBe(gained);
    const mem = w.teams.cores.get(v.teamId)!.state!.members.find((x) => x.playerId === 'star')!;
    expect(contribution({ ...mem, points: 300 + 10_000 }, mem.season, cfg.memberPointsCap)).toBe(cfg.memberPointsCap);
    expect(contribution({ ...mem, season: '2026-12', points: 50 }, '2026-12', cfg.memberPointsCap)).toBe(50); // next season: no baseline
  });

  it('team board ranks by points and skips empty teams', () => {
    const s = (teamId: string, points: number, updatedAt = 1) => ({ teamId, name: teamId, joinPolicy: 'open' as const, members: 3, points, season: '2026-11', updatedAt });
    const b = buildTeamBoard('2026-11', [s('ta', 10), s('tb', 30), s('tc', 0), s('td', 30, 0)], 5, 10);
    expect(b.file.entries.map((e) => e.teamId)).toEqual(['td', 'tb', 'ta']);
    expect(b.ranks.get('tc')).toBeUndefined();
  });
});

describe('season rewards (REQ-TEAM-007/008)', () => {
  const season = '2026-11';
  const end = seasonEndMs(season);
  function team(): TeamState {
    const t = newTeam('tabcdefgh1', 'テスト', { playerId: 'early', displayName: 'e', season, points: 0 }, 'open', '', end - 30 * DAY_MS);
    t.members.push({ playerId: 'late', role: 'member', joinedAt: end - 2 * DAY_MS, displayName: 'l', baselineSeason: season, baselinePoints: 0, season, points: 0 });
    t.former.push({ playerId: 'leftAfter', joinedAt: end - 20 * DAY_MS, leftAt: end + 1000 });
    t.former.push({ playerId: 'leftBefore', joinedAt: end - 20 * DAY_MS, leftAt: end - 1000 });
    return t;
  }

  it('JST month end, and only members who joined early enough and were in the team at the end are eligible', () => {
    expect(new Date(seasonEndMs('2026-12')).toISOString()).toBe('2026-12-31T15:00:00.000Z');
    expect(eligibleMembers(team(), cfg, season)).toEqual(['early', 'leftAfter']);
  });

  it('pays resumably and never twice', async () => {
    const t = team();
    const paid: string[] = [];
    let fail = true;
    const pay = async (pid: string) => {
      if (pid === 'leftAfter' && fail) { fail = false; throw new Error('blip'); }
      paid.push(pid);
    };
    await expect(closeSeasonStep(t, cfg, season, 1, 500, pay, 10, async () => undefined)).rejects.toThrow('blip');
    const c = await closeSeasonStep(t, cfg, season, 1, 500, pay, 10, async () => undefined);
    expect(c.done).toBe(true);
    expect(paid).toEqual(['early', 'leftAfter']);
    await closeSeasonStep(t, cfg, season, 1, 500, pay, 10, async () => undefined);
    expect(paid).toHaveLength(2);
    // teams without points get nothing; the player side is idempotent per season
    expect(teamRewardFor(cfg, 1, 0)).toBeNull();
    const p = freshPlayer('early');
    const r1 = playerTeamReward(p, cfg, season, t.id, 1, 500, end);
    const r2 = playerTeamReward(p, cfg, season, t.id, 1, 500, end);
    expect(r1.status).toBe('rewarded');
    expect(r2.status).toBe('already');
    expect(p.wallet.free).toBe(cfg.seasonRewards[0]!.reward.freeCoins);
  });
});

describe('ids', () => {
  it('team ids are t + 9 base36 chars', () => {
    expect(newTeamId(seededRng(1))).toMatch(/^t[0-9a-z]{9}$/);
  });
});
