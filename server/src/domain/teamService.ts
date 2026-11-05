import { AppError } from './errors.js';
import type { Emblem } from './visuals.js';
import type { Master } from './master.js';
import { randInt, type Rng } from './rng.js';
import {
  addRequest, assertAlive, assertMay, commitMember, disband, hasRequest, kick, leave, memberOf, newTeam, releaseSlot, removeRequest,
  reportPoints, reserveSlot, setRole, teamSummary, teamView, transfer, updateTeam, validateAnnouncement, validateTeamName,
  type JoinPolicy, type MemberSnapshot, type TeamState, type TeamSummary,
} from './teams.js';
import { jstMonthKey } from './time.js';

/**
 * REQ-TEAM-*: orchestration of a player-facing team action across the team object and the player
 * objects involved. Every multi-object step has an undo so a failure leaves no half-joined player.
 */

export type TeamView = ReturnType<typeof teamView>;

/** Operations of one team object (TeamDO in production, MemoryTeams in tests). All throw AppError. */
export interface TeamPort {
  create(teamId: string, init: { name: string; leader: MemberSnapshot; joinPolicy: JoinPolicy; announcement: string }): Promise<TeamView>;
  view(teamId: string, viewer: string | null): Promise<TeamView>;
  reserve(teamId: string, playerId: string): Promise<void>;
  release(teamId: string, playerId: string): Promise<void>;
  commit(teamId: string, member: MemberSnapshot): Promise<void>;
  request(teamId: string, playerId: string, displayName: string): Promise<'requested' | 'already'>;
  /** Actor may approve and the request exists. */
  checkRequest(teamId: string, actor: string, applicant: string): Promise<void>;
  dropRequest(teamId: string, playerId: string): Promise<boolean>;
  /** Actor may decline; removes the request. */
  decline(teamId: string, actor: string, applicant: string): Promise<boolean>;
  leave(teamId: string, playerId: string): Promise<{ disbanded: boolean }>;
  kick(teamId: string, actor: string, target: string): Promise<void>;
  setRole(teamId: string, actor: string, target: string, role: 'officer' | 'member'): Promise<void>;
  transfer(teamId: string, actor: string, target: string): Promise<void>;
  update(teamId: string, actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }): Promise<void>;
  disband(teamId: string, actor: string): Promise<void>;
  /** Leader and officers (push targets for new requests). */
  managers(teamId: string): Promise<string[]>;
  reportPoints(teamId: string, playerId: string, seasonId: string, points: number, displayName: string): Promise<void>;
}

export interface TeamPlayerState { teamId: string | null; joinedAt: number | null; cooldownUntil: number; outgoing: string[]; snapshot: MemberSnapshot }

/** Per-player steps (PlayerDO in production, PlayerService in tests). */
export interface TeamPlayers {
  prepareJoin(uid: string, teamId: string): Promise<MemberSnapshot>;
  commitJoin(uid: string, teamId: string): Promise<unknown>;
  abortJoin(uid: string, teamId: string): Promise<unknown>;
  addOutgoing(uid: string, teamId: string): Promise<MemberSnapshot>;
  removeOutgoing(uid: string, teamId: string): Promise<unknown>;
  left(uid: string, teamId: string, byChoice: boolean): Promise<unknown>;
  state(uid: string): Promise<TeamPlayerState>;
  push(uid: string, templateId: string, vars: Record<string, string>): Promise<unknown>;
}

export interface TeamDirectoryPort {
  search(query: string, limit: number): Promise<TeamSummary[]>;
}

export interface TeamBoardPort {
  /** Public snapshot (R2) of a season's team ranking. */
  board(seasonId: string): Promise<unknown>;
  rankOf(seasonId: string, teamId: string): Promise<{ rank: number; total: number; generatedAt: number | null } | null>;
}

export function newTeamId(rng: Rng): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = 't';
  for (let i = 0; i < 9; i++) s += alphabet[randInt(rng, alphabet.length)]!;
  return s;
}

export class TeamsService {
  constructor(
    private readonly master: () => Master,
    private readonly teams: TeamPort,
    private readonly players: TeamPlayers,
    private readonly directory: TeamDirectoryPort,
    private readonly board: TeamBoardPort,
    private readonly rng: Rng,
    private readonly clock: () => number = Date.now,
  ) {}

  private async myTeamId(uid: string): Promise<string> {
    const st = await this.players.state(uid);
    if (!st.teamId) throw new AppError('NOT_IN_TEAM');
    return st.teamId;
  }

  /** REQ-TEAM-001: create a team with the caller as leader. */
  async create(uid: string, name: string, joinPolicy: JoinPolicy, announcement: string) {
    const m = this.master();
    const cleanName = validateTeamName(m, name);
    const cleanText = validateAnnouncement(m, m.progression.teams, announcement);
    const teamId = newTeamId(this.rng);
    const snap = await this.players.prepareJoin(uid, teamId);
    let view: TeamView;
    try {
      view = await this.teams.create(teamId, { name: cleanName, leader: snap, joinPolicy, announcement: cleanText });
    } catch (e) {
      await this.players.abortJoin(uid, teamId);
      throw e;
    }
    await this.players.commitJoin(uid, teamId);
    return view;
  }

  /** REQ-TEAM-002: open teams are joined at once; approval teams get a request. */
  async join(uid: string, teamId: string) {
    const view = await this.teams.view(teamId, null);
    if (view.disbanded) throw new AppError('NOT_FOUND', 'team disbanded');
    if (view.joinPolicy === 'approval') {
      const snap = await this.players.addOutgoing(uid, teamId);
      try {
        const r = await this.teams.request(teamId, uid, snap.displayName);
        if (r === 'requested') {
          for (const mgr of await this.teams.managers(teamId)) {
            await this.players.push(mgr, 'team_request', { name: snap.displayName }).catch(() => undefined);
          }
        }
        return { status: 'requested' as const, teamId };
      } catch (e) {
        await this.players.removeOutgoing(uid, teamId);
        throw e;
      }
    }
    await this.admit(uid, teamId);
    return { status: 'joined' as const, teamId };
  }

  /** reserve slot → player commits → team commits (undo on every failure). */
  private async admit(uid: string, teamId: string) {
    const snap = await this.players.prepareJoin(uid, teamId);
    try {
      await this.teams.reserve(teamId, uid);
    } catch (e) {
      await this.players.abortJoin(uid, teamId);
      throw e;
    }
    try {
      await this.players.commitJoin(uid, teamId);
    } catch (e) {
      await this.teams.release(teamId, uid);
      await this.players.abortJoin(uid, teamId);
      throw e;
    }
    // The player now belongs to the team; the team's commit cannot fail on capacity (slot reserved).
    // If it failed for another reason the player would be "in" a team that lacks them, so undo that too.
    try {
      await this.teams.commit(teamId, snap);
    } catch (e) {
      await this.players.left(uid, teamId, false);
      await this.teams.release(teamId, uid);
      throw e;
    }
  }

  /** REQ-TEAM-002/003: leader or officer approves a request. */
  async approve(actor: string, applicant: string) {
    const teamId = await this.myTeamId(actor);
    await this.teams.checkRequest(teamId, actor, applicant);
    try {
      await this.admit(applicant, teamId);
    } catch (e) {
      // the applicant joined elsewhere, is cooling down or the team is full: the request is dead
      if (e instanceof AppError && e.code !== 'TEAM_FULL') {
        await this.teams.dropRequest(teamId, applicant);
        await this.players.removeOutgoing(applicant, teamId).catch(() => undefined);
      }
      throw e;
    }
    const view = await this.teams.view(teamId, null);
    await this.players.push(applicant, 'team_approved', { team: view.name }).catch(() => undefined);
    return { status: 'joined' as const, teamId, playerId: applicant };
  }

  async decline(actor: string, applicant: string) {
    const teamId = await this.myTeamId(actor);
    const removed = await this.teams.decline(teamId, actor, applicant);
    await this.players.removeOutgoing(applicant, teamId).catch(() => undefined);
    return { declined: removed };
  }

  /** The applicant withdraws a pending request. */
  async cancelRequest(uid: string, teamId: string) {
    await this.teams.dropRequest(teamId, uid).catch((e) => { if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e; });
    await this.players.removeOutgoing(uid, teamId);
    return { cancelled: true };
  }

  /** REQ-TEAM-004/007: leaving starts the rejoin cooldown. */
  async leave(uid: string) {
    const teamId = await this.myTeamId(uid);
    const r = await this.teams.leave(teamId, uid);
    await this.players.left(uid, teamId, true);
    return { left: teamId, disbanded: r.disbanded };
  }

  /** Kicked players get no cooldown (it was not their choice). */
  async kick(actor: string, target: string) {
    const teamId = await this.myTeamId(actor);
    await this.teams.kick(teamId, actor, target);
    await this.players.left(target, teamId, false);
    return { kicked: target };
  }

  async setRole(actor: string, target: string, role: 'officer' | 'member') {
    const teamId = await this.myTeamId(actor);
    await this.teams.setRole(teamId, actor, target, role);
    return this.teams.view(teamId, actor);
  }

  async transfer(actor: string, target: string) {
    const teamId = await this.myTeamId(actor);
    await this.teams.transfer(teamId, actor, target);
    return this.teams.view(teamId, actor);
  }

  async update(actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }) {
    const teamId = await this.myTeamId(actor);
    await this.teams.update(teamId, actor, patch);
    return this.teams.view(teamId, actor);
  }

  async disband(actor: string) {
    const teamId = await this.myTeamId(actor);
    await this.teams.disband(teamId, actor);
    await this.players.left(actor, teamId, false);
    return { disbanded: teamId };
  }

  /** My team, my standing in it and the team's rank as of the last snapshot. */
  async me(uid: string) {
    const st = await this.players.state(uid);
    const season = jstMonthKey(this.clock());
    if (!st.teamId) return { team: null, cooldownUntil: st.cooldownUntil, outgoing: st.outgoing, rank: null };
    const team = await this.teams.view(st.teamId, uid);
    const rank = await this.board.rankOf(season, st.teamId);
    return { team, cooldownUntil: st.cooldownUntil, outgoing: st.outgoing, rank };
  }

  view(teamId: string, viewer: string | null) { return this.teams.view(teamId, viewer); }
  search(query: string) { return this.directory.search(query.normalize('NFKC').trim().slice(0, 24), 30); }
  leaderboard(seasonId: string) { return this.board.board(seasonId); }
}

// ------------------------------------------------------------------------------------- team object core

/**
 * The operations of one team over its state; TeamDO persists `state` after each call. `onChange` gets
 * the new summary (directory + season board are updated from it).
 */
export class TeamCore {
  constructor(public state: TeamState | null, private readonly master: () => Master, private readonly clock: () => number = Date.now) {}

  private get cfg() { return this.master().progression.teams; }
  private get t(): TeamState {
    if (!this.state) throw new AppError('NOT_FOUND', 'team');
    return this.state;
  }
  summary(): TeamSummary {
    const now = this.clock();
    return teamSummary(this.t, jstMonthKey(now), this.cfg.memberPointsCap, now);
  }

  create(teamId: string, init: { name: string; leader: MemberSnapshot; joinPolicy: JoinPolicy; announcement: string }) {
    if (this.state && !this.state.disbanded) throw new AppError('CONFLICT', 'team id taken');
    this.state = newTeam(teamId, init.name, init.leader, init.joinPolicy, init.announcement, this.clock());
    return this.view(null);
  }
  view(viewer: string | null) {
    const now = this.clock();
    return teamView(this.t, this.cfg, jstMonthKey(now), viewer, now);
  }
  reserve(playerId: string) { reserveSlot(this.t, this.cfg, playerId, this.clock()); }
  release(playerId: string) { if (this.state) releaseSlot(this.state, playerId); }
  commit(m: MemberSnapshot) { commitMember(this.t, this.cfg, m, this.clock()); }
  request(playerId: string, displayName: string) { return addRequest(this.t, this.cfg, playerId, displayName, this.clock()); }
  checkRequest(actor: string, applicant: string) {
    assertMay(this.t, actor, 'approve');
    if (!hasRequest(this.t, this.cfg, applicant, this.clock())) throw new AppError('NOT_FOUND', 'no such request');
  }
  dropRequest(playerId: string) { return this.state ? removeRequest(this.state, playerId) : false; }
  decline(actor: string, applicant: string) {
    assertMay(this.t, actor, 'approve');
    return removeRequest(this.t, applicant);
  }
  leave(playerId: string) { return leave(this.t, this.cfg, playerId, this.clock()); }
  kick(actor: string, target: string) { kick(this.t, this.cfg, actor, target, this.clock()); }
  setRole(actor: string, target: string, role: 'officer' | 'member') { setRole(this.t, this.cfg, actor, target, role); }
  transfer(actor: string, target: string) { transfer(this.t, actor, target); }
  update(actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }) { updateTeam(this.master(), this.cfg, this.t, actor, patch); }
  disband(actor: string) { disband(this.t, this.cfg, actor, this.clock()); }
  managers() {
    assertAlive(this.t);
    return this.t.members.filter((m) => m.role !== 'member').map((m) => m.playerId);
  }
  reportPoints(playerId: string, seasonId: string, points: number, displayName: string) {
    return this.state ? reportPoints(this.state, playerId, seasonId, points, displayName) : false;
  }
  isMember(playerId: string) { return !!(this.state && memberOf(this.state, playerId)); }
}

/** In-memory TeamPort/TeamDirectoryPort/TeamBoardPort for tests and local tools. */
export class MemoryTeams implements TeamPort, TeamDirectoryPort, TeamBoardPort {
  readonly cores = new Map<string, TeamCore>();
  readonly summaries = new Map<string, TeamSummary>();
  constructor(private readonly master: () => Master, private readonly clock: () => number = Date.now) {}

  private core(teamId: string, create = false): TeamCore {
    let c = this.cores.get(teamId);
    if (!c) {
      if (!create) throw new AppError('NOT_FOUND', 'team');
      c = new TeamCore(null, this.master, this.clock);
      this.cores.set(teamId, c);
    }
    return c;
  }
  private touch(teamId: string) {
    const c = this.cores.get(teamId);
    if (!c?.state) return;
    if (c.state.disbanded) this.summaries.delete(teamId);
    else this.summaries.set(teamId, c.summary());
  }
  private async run<T>(teamId: string, f: (c: TeamCore) => T, create = false): Promise<T> {
    const c = this.core(teamId, create);
    const before = c.state ? structuredClone(c.state) : null;
    try {
      const r = f(c);
      this.touch(teamId);
      return r;
    } catch (e) {
      c.state = before; // all-or-nothing like the Durable Object
      throw e;
    }
  }

  create(teamId: string, init: Parameters<TeamPort['create']>[1]) { return this.run(teamId, (c) => c.create(teamId, init), true); }
  view(teamId: string, viewer: string | null) { return this.run(teamId, (c) => c.view(viewer)); }
  reserve(teamId: string, p: string) { return this.run(teamId, (c) => c.reserve(p)); }
  release(teamId: string, p: string) { return this.run(teamId, (c) => c.release(p)); }
  commit(teamId: string, m: MemberSnapshot) { return this.run(teamId, (c) => c.commit(m)); }
  request(teamId: string, p: string, name: string) { return this.run(teamId, (c) => c.request(p, name)); }
  checkRequest(teamId: string, a: string, p: string) { return this.run(teamId, (c) => c.checkRequest(a, p)); }
  dropRequest(teamId: string, p: string) { return this.run(teamId, (c) => c.dropRequest(p)); }
  decline(teamId: string, a: string, p: string) { return this.run(teamId, (c) => c.decline(a, p)); }
  leave(teamId: string, p: string) { return this.run(teamId, (c) => c.leave(p)); }
  kick(teamId: string, a: string, t: string) { return this.run(teamId, (c) => c.kick(a, t)); }
  setRole(teamId: string, a: string, t: string, r: 'officer' | 'member') { return this.run(teamId, (c) => c.setRole(a, t, r)); }
  transfer(teamId: string, a: string, t: string) { return this.run(teamId, (c) => c.transfer(a, t)); }
  update(teamId: string, a: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }) { return this.run(teamId, (c) => c.update(a, patch)); }
  disband(teamId: string, a: string) { return this.run(teamId, (c) => c.disband(a)); }
  managers(teamId: string) { return this.run(teamId, (c) => c.managers()); }
  async reportPoints(teamId: string, p: string, season: string, points: number, name: string) { await this.run(teamId, (c) => c.reportPoints(p, season, points, name)); }

  async search(q: string, limit: number) {
    const f = q.toLowerCase();
    return [...this.summaries.values()].filter((s) => !f || s.name.toLowerCase().includes(f) || s.teamId === f).sort((a, b) => b.points - a.points).slice(0, limit);
  }
  async board(seasonId: string) {
    const list = [...this.summaries.values()].filter((s) => s.season === seasonId && s.points > 0).sort((a, b) => b.points - a.points);
    return { seasonId, board: 'teams', total: list.length, entries: list.map((s, i) => ({ rank: i + 1, ...s })) };
  }
  async rankOf(seasonId: string, teamId: string) {
    const b = await this.board(seasonId);
    const e = b.entries.find((x) => x.teamId === teamId);
    return e ? { rank: e.rank, total: b.total, generatedAt: null } : null;
  }
}
