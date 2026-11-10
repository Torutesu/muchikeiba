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
import { leagueTick, newLeague, teamLeagueView, type LeagueState } from './league.js';
import {
  feedForget, feedGoal, feedPage, feedPost, feedRace, feedReact, feedReport, newFeed, type FeedItem, type FeedRace, type ReportReason, type TeamFeedState,
  type stampCatalog, qchatLeft, qchatPost, qchatSetBlocks, qchatUsage,
} from './teamFeed.js';
import { slotValue, type QChatOption, type QChatSlotInput, type QSlot, type playerQchatOptions } from './quickChat.js';
import type { Locale } from '../i18n/locale.js';
import {
  goalContribute, goalForget, goalMemberLeft, goalMembersChanged, goalPayStep, goalRoll, goalTeamView, goalUnpaid, newGoalState, teamGoalConfig, weekEndMs,
  type GoalClose, type GoalContribution, type GoalCounted, type TeamGoalState, type playerGoalView,
} from './teamGoal.js';
import { dayRule } from './time.js';
export type TeamGoalView = ReturnType<TeamCore['goalView']>;
/** A counted contribution plus the members to notify of a newly reached milestone (REQ-TGOAL-008). */
export type GoalContributeResult = GoalCounted & { notify: string[]; teamName: string };
export type TeamFeedPage = ReturnType<typeof feedPage>;
export type TeamLeagueView = ReturnType<typeof teamLeagueView>;

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
  // REQ-TEAMFEED-*: the feed lives in the team object (members only, except forget)
  feedPost(teamId: string, playerId: string, stampId: string): Promise<FeedItem>;
  feedRace(teamId: string, playerId: string, race: FeedRace): Promise<FeedItem | null>;
  feedReact(teamId: string, playerId: string, seq: number, stampId: string | null): Promise<{ ownerId: string; isNew: boolean; kind: FeedItem['kind']; phraseId?: string | null }>;
  feedReport(teamId: string, playerId: string, seq: number): Promise<{ ownerId: string; first: boolean }>;
  /** `locale` (REQ-QCHAT-009): quick chat items are rendered in the viewer's language. Also refreshes the viewer's block copy. */
  feedPage(teamId: string, viewer: string, muted: string[], before: number | null, limit: number | null, locale?: Locale): Promise<TeamFeedPage>;
  // REQ-QCHAT-*: quick chat posts live in the same feed
  qchatPost(teamId: string, playerId: string, phraseId: string, slots: QSlot[], muted: string[]): Promise<QchatPostResult>;
  /** The members a phrase may name (no block relation either way) and the viewer's usage today. */
  qchatMembers(teamId: string, viewer: string, muted: string[], locale: Locale): Promise<{ player: QChatOption[]; usage: ReturnType<typeof qchatUsage> }>;
  qchatBlocks(teamId: string, playerId: string, muted: string[]): Promise<unknown>;
  /** REQ-UXS-040: removes a deleted player's items and reactions (no membership needed). Also their team goal contribution (REQ-TGOAL-006). */
  feedForget(teamId: string, playerId: string): Promise<{ removed: number }>;
  // REQ-TGOAL-*: the weekly goal lives in the team object
  goalView(teamId: string, viewer: string): Promise<TeamGoalView>;
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
  // REQ-TEAMFEED-*
  stampCatalog(uid: string): Promise<ReturnType<typeof stampCatalog>>;
  stampCheck(uid: string, stampId: string): Promise<{ teamId: string; displayName: string }>;
  /** `ref`: the stored feed item / reaction (REQ-ACH-002 counts a cheer once per ref). */
  stampPosted(uid: string, stampId: string, kind: 'post' | 'reaction', teamId: string, ref?: string | null): Promise<unknown>;
  feedViewer(uid: string, firstPage: boolean): Promise<{ teamId: string | null; muted: string[] }>;
  feedMutes(uid: string): Promise<{ muted: string[] }>;
  feedMute(uid: string, target: string, muted: boolean): Promise<{ muted: string[] }>;
  feedReported(uid: string, teamId: string, seq: number, reporter: string, reason: ReportReason): Promise<unknown>;
  /** `ref`: the reaction (`react:{teamId}:{seq}`), the activity entry's source id (REQ-ACT-002). */
  cheerPush(uid: string, fromId: string, fromName: string, ref?: string): Promise<unknown>;
  /** REQ-TGOAL-008: today's units sent and the last paid week. */
  goalPlayerView(uid: string): Promise<ReturnType<typeof playerGoalView>>;
  // REQ-QCHAT-*
  qchatOptions(uid: string, locale: Locale): Promise<ReturnType<typeof playerQchatOptions>>;
  qchatCheck(uid: string, phraseId: string, slots: QChatSlotInput): Promise<{ teamId: string; displayName: string; muted: string[]; slots: QSlot[]; mention: boolean }>;
  /** After the team stored it: the KPI row (`qchat_post` / `qchat_react`). */
  qchatNote(uid: string, kind: 'post' | 'react', a: string, b: string, teamId: string, n: number): Promise<unknown>;
  /** REQ-QCHAT-012: the named member's activity entry (`ref` = `qchat:{teamId}:{seq}`). */
  qchatMention(uid: string, fromId: string, fromName: string, ref: string): Promise<unknown>;
}

export interface QchatPostResult { seq: number; at: number; phraseId: string; mention: string | null }

export interface TeamDirectoryPort {
  search(query: string, limit: number): Promise<TeamSummary[]>;
}

export interface TeamBoardPort {
  /** Public snapshot (R2) of a season's team ranking. */
  board(seasonId: string): Promise<unknown>;
  rankOf(seasonId: string, teamId: string): Promise<{ rank: number; total: number; generatedAt: number | null } | null>;
  /** REQ-LEAGUE-005: a team's live league view this season (the season's board object). */
  leagueOf(seasonId: string, teamId: string): Promise<TeamLeagueView>;
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

  // ---------------------------------------------------------------- cheer stamps (REQ-TEAMFEED-*)

  /** REQ-TEAMFEED-001: the stamp set with the caller's unlocks. */
  stamps(uid: string) { return this.players.stampCatalog(uid); }

  /** REQ-TEAMFEED-003: post a stamp (player checks → team stores with its rate limit → KPI). */
  async postStamp(uid: string, stampId: string) {
    const info = await this.players.stampCheck(uid, stampId);
    const item = await this.teams.feedPost(info.teamId, uid, stampId);
    await this.players.stampPosted(uid, stampId, 'post', info.teamId, `post:${info.teamId}:${item.seq}`).catch(() => undefined);
    return { teamId: info.teamId, seq: item.seq, at: item.at, stampId };
  }

  /**
   * REQ-TEAMFEED-005: react to an item with a stamp (null removes the reaction). A new reaction to a teammate's race
   * result may notify them (push, optional; muted members never notify).
   */
  async react(uid: string, seq: number, stampId: string | null) {
    const info = stampId !== null ? await this.players.stampCheck(uid, stampId) : { teamId: await this.myTeamId(uid), displayName: '' };
    const r = await this.teams.feedReact(info.teamId, uid, seq, stampId);
    if (r.isNew && stampId !== null) {
      await this.players.stampPosted(uid, stampId, 'reaction', info.teamId, `react:${info.teamId}:${seq}`).catch(() => undefined);
      // REQ-QCHAT-011: a new reaction to a quick chat post
      if (r.kind === 'qchat') await this.players.qchatNote(uid, 'react', stampId, r.phraseId ?? '', info.teamId, 0).catch(() => undefined);
      if (r.kind === 'race' && r.ownerId !== uid) await this.players.cheerPush(r.ownerId, uid, info.displayName, `react:${info.teamId}:${seq}`).catch(() => undefined);
    }
    return { teamId: info.teamId, seq, myReaction: stampId };
  }

  /** REQ-TEAMFEED-005/006: a page of my team's feed (newest first), muted members left out. */
  async feed(uid: string, before: number | null, limit: number | null, locale: Locale = 'ja') {
    const v = await this.players.feedViewer(uid, before === null);
    if (!v.teamId) throw new AppError('NOT_IN_TEAM');
    return { teamId: v.teamId, ...(await this.teams.feedPage(v.teamId, uid, v.muted, before, limit, locale)), muted: v.muted };
  }

  mutes(uid: string) { return this.players.feedMutes(uid); }
  /**
   * REQ-TEAMFEED-006: mute (block) / unmute a member; applies to the feed and to cheer pushes. REQ-QCHAT-007: the branch's
   * copy of the list is refreshed at once (best effort: the next feed read refreshes it again).
   */
  async mute(uid: string, target: string, muted: boolean) {
    const r = await this.players.feedMute(uid, target, muted);
    const st = await this.players.state(uid).catch(() => null);
    if (st?.teamId) await this.teams.qchatBlocks(st.teamId, uid, r.muted).catch(() => undefined);
    return r;
  }

  // ---------------------------------------------------------------- quick chat (REQ-QCHAT-*, protocol §52)

  /** REQ-QCHAT-008: phrases in my language and the values a post would accept (members only when in a branch). */
  async quickChat(uid: string, locale: Locale = 'ja') {
    const { muted, ...v } = await this.players.qchatOptions(uid, locale);
    if (!v.teamId || !v.enabled) return { ...v, usage: { postsToday: 0, mentionsToday: 0, nextPostAt: this.clock() } };
    const t = await this.teams.qchatMembers(v.teamId, uid, muted, locale);
    return { ...v, options: { ...v.options, player: t.player }, usage: t.usage };
  }

  /**
   * REQ-QCHAT-003..005/011/012: post a phrase — the player's object checks the slots, the branch stores it with its limits,
   * then the KPI row and (for a mention phrase) the named member's activity entry, both best effort.
   */
  async postQuickChat(uid: string, phraseId: string, slots: QChatSlotInput) {
    const info = await this.players.qchatCheck(uid, phraseId, slots);
    const r = await this.teams.qchatPost(info.teamId, uid, phraseId, info.slots, info.muted);
    await this.players.qchatNote(uid, 'post', phraseId, info.mention ? 'mention' : '', info.teamId, info.slots.length).catch(() => undefined);
    if (r.mention) await this.players.qchatMention(r.mention, uid, info.displayName, `qchat:${info.teamId}:${r.seq}`).catch(() => undefined);
    return { teamId: info.teamId, seq: r.seq, at: r.at, phraseId };
  }

  /** REQ-TEAMFEED-007: report an item: hidden for me, support flag on its owner. */
  async report(uid: string, seq: number, reason: ReportReason) {
    const teamId = await this.myTeamId(uid);
    const r = await this.teams.feedReport(teamId, uid, seq);
    if (r.first) await this.players.feedReported(r.ownerId, teamId, seq, uid, reason);
    return { reported: true, seq };
  }

  /** REQ-TGOAL-008: my team's weekly goal — progress, milestones, my contribution, top contributors, last week's result. */
  async goal(uid: string) {
    const st = await this.players.state(uid);
    const player = await this.players.goalPlayerView(uid);
    if (!st.teamId) return { teamId: null, teamName: null, enabled: player.enabled, current: null, lastWeek: null, player };
    return { teamId: st.teamId, ...(await this.teams.goalView(st.teamId, uid)), player };
  }

  /** REQ-LEAGUE-005: my team's league this season — division table, weekly matchups and (after the season) its place. */
  async league(uid: string) {
    const st = await this.players.state(uid);
    const season = jstMonthKey(this.clock());
    const cfg = this.master().progression.league;
    const divisions = cfg.divisions.map((d) => ({ id: d.id, name: d.name }));
    if (!st.teamId) return { teamId: null, season, divisions, ...teamLeagueView(null, cfg, '', this.clock()) };
    return { teamId: st.teamId, season, divisions, ...(await this.board.leagueOf(season, st.teamId)) };
  }
}

// ------------------------------------------------------------------------------------- team object core

/**
 * The operations of one team over its state; TeamDO persists `state` after each call. `onChange` gets
 * the new summary (directory + season board are updated from it).
 */
export class TeamCore {
  /** REQ-TEAMFEED-*: the team feed (stored under its own key by TeamDO). */
  public feed: TeamFeedState = newFeed();
  /** REQ-TGOAL-*: the weekly goal (stored under its own key by TeamDO). */
  public goal: TeamGoalState = newGoalState();
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
  commit(m: MemberSnapshot) {
    this.goalTick();
    commitMember(this.t, this.cfg, m, this.clock());
    const cfg = teamGoalConfig(this.master());
    if (cfg) { this.goalTick(); goalMembersChanged(cfg, this.goal, this.t); }
  }
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
  leave(playerId: string) { this.goalTick(); const r = leave(this.t, this.cfg, playerId, this.clock()); goalMemberLeft(this.goal, playerId); qchatLeft(this.feed, playerId); return r; }
  kick(actor: string, target: string) { this.goalTick(); kick(this.t, this.cfg, actor, target, this.clock()); goalMemberLeft(this.goal, target); qchatLeft(this.feed, target); }
  setRole(actor: string, target: string, role: 'officer' | 'member') { setRole(this.t, this.cfg, actor, target, role); }
  transfer(actor: string, target: string) { transfer(this.t, actor, target); }
  update(actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }) { updateTeam(this.master(), this.cfg, this.t, actor, patch); }
  disband(actor: string) { this.goalTick(); disband(this.t, this.cfg, actor, this.clock()); goalMemberLeft(this.goal, actor); }
  managers() {
    assertAlive(this.t);
    return this.t.members.filter((m) => m.role !== 'member').map((m) => m.playerId);
  }
  reportPoints(playerId: string, seasonId: string, points: number, displayName: string) {
    return this.state ? reportPoints(this.state, playerId, seasonId, points, displayName) : false;
  }
  isMember(playerId: string) { return !!(this.state && memberOf(this.state, playerId)); }

  // REQ-TEAMFEED-*
  private member(playerId: string) {
    assertAlive(this.t);
    const mm = memberOf(this.t, playerId);
    if (!mm) throw new AppError('NOT_IN_TEAM');
    return mm;
  }
  feedPost(playerId: string, stampId: string) {
    const mm = this.member(playerId);
    return feedPost(this.master(), this.feed, { playerId, displayName: mm.displayName }, stampId, this.clock());
  }
  /** From the player's object after a race: ignored when the player is no longer a member. */
  feedRace(playerId: string, race: FeedRace) {
    if (!this.state || this.state.disbanded) return null;
    const mm = memberOf(this.state, playerId);
    if (!mm) return null;
    return feedRace(this.master(), this.feed, { playerId, displayName: mm.displayName }, race, this.clock());
  }
  feedReact(playerId: string, seq: number, stampId: string | null) { this.member(playerId); return feedReact(this.master(), this.feed, seq, playerId, stampId, this.clock()); }
  feedReport(playerId: string, seq: number) { this.member(playerId); return feedReport(this.master(), this.feed, seq, playerId, this.clock()); }
  feedPage(viewer: string, muted: string[], before: number | null, limit: number | null, locale: Locale = 'ja') {
    this.member(viewer);
    qchatSetBlocks(this.master(), this.feed, viewer, muted); // REQ-QCHAT-007: the viewer's block copy
    return feedPage(this.master(), this.feed, viewer, muted, this.names(), before, limit, locale, this.t.id, this.clock());
  }
  private names() { return new Map(this.t.members.map((x) => [x.playerId, x.displayName])); }

  // REQ-QCHAT-*
  qchatPost(playerId: string, phraseId: string, slots: QSlot[], muted: string[]): QchatPostResult {
    const mm = this.member(playerId);
    qchatSetBlocks(this.master(), this.feed, playerId, muted);
    const r = qchatPost(this.master(), this.feed, { playerId, displayName: mm.displayName }, new Set(this.t.members.map((x) => x.playerId)), phraseId, slots, this.clock());
    return { seq: r.item.seq, at: r.item.at, phraseId, mention: r.mention };
  }
  qchatMembers(viewer: string, muted: string[], locale: Locale) {
    this.member(viewer);
    qchatSetBlocks(this.master(), this.feed, viewer, muted);
    const names = this.names();
    const blocks = this.feed.qchat?.blocks ?? {};
    const mine = new Set(muted);
    const player = this.t.members.filter((x) => x.playerId !== viewer && !mine.has(x.playerId) && !(blocks[x.playerId] ?? []).includes(viewer))
      .map((x) => ({ ref: x.playerId, qchatValue: slotValue(this.master(), { name: 'player', ref: x.playerId }, locale, names) }))
      .sort((a, b) => (a.qchatValue < b.qchatValue ? -1 : a.qchatValue > b.qchatValue ? 1 : 0));
    return { player, usage: qchatUsage(this.master(), this.feed, viewer, this.clock()) };
  }
  /** REQ-QCHAT-007: a member's block copy (ignored for a non-member). */
  qchatBlocks(playerId: string, muted: string[]) {
    if (!this.isMember(playerId)) return { updated: false };
    qchatSetBlocks(this.master(), this.feed, playerId, muted);
    return { updated: true };
  }
  feedForget(playerId: string) { this.goalForget(playerId); return feedForget(this.feed, playerId); }

  // REQ-TGOAL-*
  /** Closes a finished week (with the members it ended with) and opens the current one. Returns the week closed now. */
  goalTick(): GoalClose | null {
    const cfg = teamGoalConfig(this.master());
    if (!cfg || !this.state) return null;
    return goalRoll(cfg, dayRule(this.master()), this.goal, this.state, this.clock());
  }
  /** From a player's object after a confirmed event; a newly reached milestone posts a team feed item once. */
  goalContribute(c: GoalContribution): GoalContributeResult {
    const m = this.master();
    const cfg = teamGoalConfig(m);
    const teamName = this.state?.name ?? '';
    if (!cfg) return { counted: 0, milestone: null, progress: 0, tier: 0, reason: 'no_goal', notify: [], teamName };
    const r = goalContribute(cfg, dayRule(m), this.goal, this.state, c, this.clock());
    let notify: string[] = [];
    const w = this.goal.cur;
    if (r.milestone !== null && w && this.state) {
      feedGoal(m, this.feed, { week: w.week, goalId: w.goalId, label: w.label, tier: r.milestone, target: w.targets[r.milestone - 1]!, tiers: w.targets.length }, this.clock());
      notify = this.state.members.map((x) => x.playerId).filter((x) => x !== c.playerId);
    }
    return { ...r, notify, teamName };
  }
  /** REQ-TGOAL-008: members only. */
  goalView(viewer: string) {
    const m = this.master();
    const cfg = teamGoalConfig(m);
    this.member(viewer);
    if (!cfg) return { teamName: this.t.name, enabled: false as boolean, current: null, lastWeek: null };
    return { teamName: this.t.name, enabled: true as boolean, ...goalTeamView(cfg, dayRule(m), this.goal, this.t, viewer, this.clock()) };
  }
  /** REQ-TGOAL-006: a deleted or quarantined player's contribution leaves the team's progress (no membership needed). */
  goalForget(playerId: string) { return goalForget(this.goal, playerId); }
  /** REQ-TGOAL-007: one payout step of the oldest unpaid closed week (the alarm runs it until nothing is left). */
  async goalPay(pay: (playerId: string, c: GoalClose) => Promise<void>, persist: () => Promise<void>) {
    this.goalTick();
    const cfg = teamGoalConfig(this.master());
    return goalPayStep(this.goal, this.state?.id ?? '', cfg?.payBatch ?? 50, pay, persist);
  }
  /** When the team object should wake next: now for an unpaid week, else when the running week ends. */
  goalNextWake(): number | null {
    if (!teamGoalConfig(this.master()) || !this.state || this.state.disbanded) return goalUnpaid(this.goal) ? this.clock() : null;
    if (goalUnpaid(this.goal)) return this.clock();
    const w = this.goal.cur;
    return w ? weekEndMs(w.week, dayRule(this.master())) : null;
  }
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
    const feedBefore = structuredClone(c.feed);
    const goalBefore = structuredClone(c.goal);
    try {
      const r = f(c);
      this.touch(teamId);
      return r;
    } catch (e) {
      c.state = before; // all-or-nothing like the Durable Object
      c.feed = feedBefore;
      c.goal = goalBefore;
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
  feedPost(teamId: string, p: string, stampId: string) { return this.run(teamId, (c) => c.feedPost(p, stampId)); }
  async feedRace(teamId: string, p: string, race: FeedRace) { return this.cores.has(teamId) ? this.run(teamId, (c) => c.feedRace(p, race)) : null; }
  feedReact(teamId: string, p: string, seq: number, stampId: string | null) { return this.run(teamId, (c) => c.feedReact(p, seq, stampId)); }
  feedReport(teamId: string, p: string, seq: number) { return this.run(teamId, (c) => c.feedReport(p, seq)); }
  feedPage(teamId: string, viewer: string, muted: string[], before: number | null, limit: number | null, locale: Locale = 'ja') { return this.run(teamId, (c) => c.feedPage(viewer, muted, before, limit, locale)); }
  qchatPost(teamId: string, p: string, phraseId: string, slots: QSlot[], muted: string[]) { return this.run(teamId, (c) => c.qchatPost(p, phraseId, slots, muted)); }
  qchatMembers(teamId: string, viewer: string, muted: string[], locale: Locale) { return this.run(teamId, (c) => c.qchatMembers(viewer, muted, locale)); }
  async qchatBlocks(teamId: string, p: string, muted: string[]) { return this.cores.has(teamId) ? this.run(teamId, (c) => c.qchatBlocks(p, muted)) : { updated: false }; }
  async feedForget(teamId: string, p: string) { return this.cores.has(teamId) ? this.run(teamId, (c) => c.feedForget(p)) : { removed: 0 }; }
  // REQ-TGOAL-* (pushes for milestones are sent by the caller in tests, by TeamDO in production)
  async goalContribute(teamId: string, c: GoalContribution) {
    return this.cores.has(teamId) ? this.run(teamId, (x) => x.goalContribute(c)) : { counted: 0, milestone: null, progress: 0, tier: 0, reason: 'no_goal' as const, notify: [], teamName: '' };
  }
  goalView(teamId: string, viewer: string) { return this.run(teamId, (c) => c.goalView(viewer)); }
  async goalForget(teamId: string, p: string) { return this.cores.has(teamId) ? this.run(teamId, (c) => c.goalForget(p)) : { removed: 0 }; }
  /** The TeamDO alarm, in memory: closes a finished week and pays until nothing is left. */
  async goalAlarm(teamId: string, pay: (playerId: string, c: GoalClose) => Promise<void>) {
    const c = this.core(teamId);
    let r = await c.goalPay(pay, async () => undefined);
    while (!r.done && r.paid > 0) r = await c.goalPay(pay, async () => undefined);
    return r;
  }

  async search(q: string, limit: number) {
    const f = q.toLowerCase();
    return [...this.summaries.values()].filter((s) => !f || s.name.toLowerCase().includes(f) || s.teamId === f).sort((a, b) => b.points - a.points).slice(0, limit).map(({ stints: _s, ...x }) => x); // like the directory: no per-member data
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

  /** League per season, ticked by `leagueStep` (the LeaderboardDO's cron step, in memory). */
  readonly leagues = new Map<string, LeagueState>();
  leagueStep(seasonId: string, now: number, carry: Record<string, string> = {}) {
    const cfg = this.master().progression.league;
    const st = this.leagues.get(seasonId) ?? newLeague(seasonId, cfg, carry);
    this.leagues.set(seasonId, st);
    leagueTick(st, cfg, [...this.summaries.values()].filter((s) => s.season === seasonId), now);
    return st;
  }
  async leagueOf(seasonId: string, teamId: string) {
    return teamLeagueView(this.leagues.get(seasonId) ?? null, this.master().progression.league, teamId, this.clock());
  }
}
