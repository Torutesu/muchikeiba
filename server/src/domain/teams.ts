import type { Give } from './giftBox.js';
import { AppError } from './errors.js';
import { defaultEmblem, validateEmblem, type Emblem } from './visuals.js';
import { grantReward } from './items.js';
import type { Master, Reward, TeamsConfig } from './master.js';
import { leagueRewardFor, type LeagueConfig, type LeaguePlace } from './league.js';
import type { PlayerState } from './player.js';
import { foldForCompare } from './horses.js';
import { DAY_MS, jstMonthKey } from './time.js';

/**
 * 支部（チーム戦） REQ-TEAM-*. Pure logic shared by the TeamDO (one Durable Object per team, so teams
 * never contend with each other and a team's membership changes are serialized) and by tests.
 *
 * Authority split (two objects, no distributed transaction):
 * - the TEAM object is the authority for capacity, roles and requests;
 * - the PLAYER object is the authority for "which team am I in" (one field) and the leave cooldown.
 * Joining is a reserve → player commit → team commit sequence with an undo on failure
 * (src/domain/teamService.ts), so a player can never end up in two teams and a team never exceeds
 * its size.
 */

export type TeamRole = 'leader' | 'officer' | 'member';
export type JoinPolicy = 'open' | 'approval';

export interface TeamMember {
  playerId: string; role: TeamRole; joinedAt: number; displayName: string;
  /** Season points the player already had when joining (only that season): not credited to the team. */
  baselineSeason: string; baselinePoints: number;
  /** Latest reported standing. */
  season: string; points: number;
}
export interface TeamFormer { playerId: string; joinedAt: number; leftAt: number }
export interface TeamRequest { playerId: string; displayName: string; at: number }
export interface TeamSeasonClose {
  rank: number | null; total: number; eligible: string[]; cursor: number; done: boolean;
  /** REQ-LEAGUE-004: the team's final league place this season (fixed with the eligible list). */
  league?: LeaguePlace | null;
}

export interface TeamState {
  v: 1; id: string; name: string; createdAt: number; joinPolicy: JoinPolicy; announcement: string;
  /** REQ-ASSET-007: emblem from the fixed parts set; absent = derived from the team id. */
  emblem?: Emblem;
  members: TeamMember[]; former: TeamFormer[]; requests: TeamRequest[];
  /** Slots held while a player's own object commits the join (expire after RESERVE_TTL_MS). */
  reserved: { playerId: string; at: number }[];
  disbanded: boolean;
  /** REQ-TEAM-008: per closed season, reward distribution progress (resumable). */
  closes: Record<string, TeamSeasonClose>;
  /**
   * REQ-LEAGUE-003: contributions of members who left during `season`, frozen at the moment they left (by
   * stint key, see stintKey). League windows score per-stint growth, so a departure keeps what the member
   * earned for the team inside the window instead of taking it away.
   */
  leftStints?: { season: string; byKey: Record<string, number> };
}

export interface MemberSnapshot { playerId: string; displayName: string; season: string; points: number }

export const RESERVE_TTL_MS = 60_000;
export const TEAM_ID_RE = /^t[0-9a-z]{6,16}$/;

// ------------------------------------------------------------------------------------- validation

/** REQ-TEAM-001: 2–12 characters, NG list, no URLs or control characters. */
export function validateTeamName(m: Master, raw: string): string {
  const name = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...name].length;
  if (len < 2 || len > 12) throw new AppError('INVALID_NAME', '2〜12文字');
  checkText(m, name);
  return name;
}

/** REQ-TEAM-006: a short announcement instead of chat; same NG rules. */
export function validateAnnouncement(m: Master, cfg: TeamsConfig, raw: string): string {
  const text = raw.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if ([...text].length > cfg.announcementMax) throw new AppError('BAD_REQUEST', `announcement is longer than ${cfg.announcementMax} characters`);
  if (text.length > 0) checkText(m, text.replace(/\n/g, ' '));
  return text;
}

function checkText(m: Master, text: string) {
  if (/[\p{Cc}\p{Cf}]/u.test(text.replace(/\n/g, ''))) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp|io|me)\b/i.test(text)) throw new AppError('INVALID_NAME', 'no URLs');
  const f = foldForCompare(text);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
}

// ------------------------------------------------------------------------------------- team state

export function newTeam(id: string, name: string, leader: MemberSnapshot, joinPolicy: JoinPolicy, announcement: string, now: number): TeamState {
  if (!TEAM_ID_RE.test(id)) throw new AppError('BAD_REQUEST', 'bad team id');
  return {
    v: 1, id, name, createdAt: now, joinPolicy, announcement,
    members: [memberFrom(leader, 'leader', now)], former: [], requests: [], reserved: [], disbanded: false, closes: {},
  };
}

const memberFrom = (p: MemberSnapshot, role: TeamRole, now: number): TeamMember => ({
  playerId: p.playerId, role, joinedAt: now, displayName: p.displayName,
  baselineSeason: p.season, baselinePoints: p.points, season: p.season, points: p.points,
});

export function assertAlive(t: TeamState) {
  if (t.disbanded) throw new AppError('NOT_FOUND', 'team disbanded');
}

export const memberOf = (t: TeamState, playerId: string) => t.members.find((m) => m.playerId === playerId);

export function roleOf(t: TeamState, playerId: string): TeamRole {
  const m = memberOf(t, playerId);
  if (!m) throw new AppError('NOT_IN_TEAM');
  return m.role;
}

export type TeamAction = 'approve' | 'kick' | 'announce' | 'policy' | 'roles' | 'transfer' | 'disband';

/** REQ-TEAM-003: leader can do everything; officers approve/decline requests, kick plain members and edit the announcement. */
export function assertMay(t: TeamState, actor: string, action: TeamAction, target?: string) {
  assertAlive(t);
  const role = roleOf(t, actor);
  if (role === 'leader') return;
  if (role === 'officer' && (action === 'approve' || action === 'announce')) return;
  if (role === 'officer' && action === 'kick' && target !== undefined && memberOf(t, target)?.role === 'member') return;
  throw new AppError('FORBIDDEN', `${role} cannot ${action}`);
}

function gcReserved(t: TeamState, now: number) {
  t.reserved = t.reserved.filter((r) => now - r.at < RESERVE_TTL_MS);
}
function gcRequests(t: TeamState, cfg: TeamsConfig, now: number) {
  t.requests = t.requests.filter((r) => now - r.at < cfg.requestTtlMs);
}

/** Holds a slot for a joining player (capacity counts members + live reservations). */
export function reserveSlot(t: TeamState, cfg: TeamsConfig, playerId: string, now: number) {
  assertAlive(t);
  if (memberOf(t, playerId)) throw new AppError('ALREADY_IN_TEAM');
  gcReserved(t, now);
  if (t.reserved.some((r) => r.playerId === playerId)) return;
  if (t.members.length + t.reserved.length >= cfg.maxMembers) throw new AppError('TEAM_FULL');
  t.reserved.push({ playerId, at: now });
}

export function releaseSlot(t: TeamState, playerId: string) {
  t.reserved = t.reserved.filter((r) => r.playerId !== playerId);
}

/** Completes a join after the player's object recorded the membership. Idempotent. */
export function commitMember(t: TeamState, cfg: TeamsConfig, p: MemberSnapshot, now: number): TeamMember {
  assertAlive(t);
  const existing = memberOf(t, p.playerId);
  if (existing) return existing;
  gcReserved(t, now);
  const held = t.reserved.some((r) => r.playerId === p.playerId);
  if (!held && t.members.length + t.reserved.length >= cfg.maxMembers) throw new AppError('TEAM_FULL');
  releaseSlot(t, p.playerId);
  t.requests = t.requests.filter((r) => r.playerId !== p.playerId);
  const m = memberFrom(p, 'member', now);
  t.members.push(m);
  return m;
}

/** REQ-TEAM-002: approval-policy teams queue requests (capped, expiring). */
export function addRequest(t: TeamState, cfg: TeamsConfig, playerId: string, displayName: string, now: number): 'requested' | 'already' {
  assertAlive(t);
  if (t.joinPolicy !== 'approval') throw new AppError('BAD_REQUEST', 'this team is open: join directly');
  if (memberOf(t, playerId)) throw new AppError('ALREADY_IN_TEAM');
  gcRequests(t, cfg, now);
  if (t.requests.some((r) => r.playerId === playerId)) return 'already';
  if (t.requests.length >= cfg.maxPendingRequests) throw new AppError('TEAM_LIMIT', 'too many pending requests');
  t.requests.push({ playerId, displayName, at: now });
  return 'requested';
}

export function hasRequest(t: TeamState, cfg: TeamsConfig, playerId: string, now: number) {
  gcRequests(t, cfg, now);
  return t.requests.some((r) => r.playerId === playerId);
}

export function removeRequest(t: TeamState, playerId: string): boolean {
  const n = t.requests.length;
  t.requests = t.requests.filter((r) => r.playerId !== playerId);
  return t.requests.length !== n;
}

function pruneFormer(t: TeamState, cfg: TeamsConfig, now: number) {
  t.former = t.former.filter((f) => now - f.leftAt < cfg.formerMemberKeepMs);
}

/** Removes a member (leave or kick); the departure is remembered for reward eligibility of a just-closed season. */
export function removeMember(t: TeamState, cfg: TeamsConfig, playerId: string, now: number): TeamMember {
  const m = memberOf(t, playerId);
  if (!m) throw new AppError('NOT_IN_TEAM');
  const season = jstMonthKey(now);
  if (t.leftStints?.season !== season) t.leftStints = { season, byKey: {} };
  t.leftStints.byKey[stintKey(m)] = contribution(m, season, cfg.memberPointsCap);
  t.members = t.members.filter((x) => x.playerId !== playerId);
  t.former.push({ playerId, joinedAt: m.joinedAt, leftAt: now });
  pruneFormer(t, cfg, now);
  return m;
}

/** REQ-TEAM-004: a leader cannot just leave a team that still has members; a lone leader leaving disbands it. */
export function leave(t: TeamState, cfg: TeamsConfig, playerId: string, now: number): { disbanded: boolean } {
  assertAlive(t);
  const m = memberOf(t, playerId);
  if (!m) throw new AppError('NOT_IN_TEAM');
  if (m.role === 'leader' && t.members.length > 1) throw new AppError('TEAM_LEADER_MUST_TRANSFER');
  removeMember(t, cfg, playerId, now);
  if (t.members.length === 0) t.disbanded = true;
  return { disbanded: t.disbanded };
}

export function kick(t: TeamState, cfg: TeamsConfig, actor: string, target: string, now: number) {
  if (actor === target) throw new AppError('BAD_REQUEST', 'use leave');
  assertMay(t, actor, 'kick', target);
  if (memberOf(t, target)?.role === 'leader') throw new AppError('FORBIDDEN', 'cannot kick the leader');
  removeMember(t, cfg, target, now);
}

export function setRole(t: TeamState, cfg: TeamsConfig, actor: string, target: string, role: 'officer' | 'member') {
  assertMay(t, actor, 'roles');
  const m = memberOf(t, target);
  if (!m) throw new AppError('NOT_IN_TEAM');
  if (m.role === 'leader') throw new AppError('BAD_REQUEST', 'use transfer');
  if (role === 'officer' && m.role !== 'officer' && t.members.filter((x) => x.role === 'officer').length >= cfg.maxOfficers) {
    throw new AppError('TEAM_LIMIT', `at most ${cfg.maxOfficers} officers`);
  }
  m.role = role;
}

/** REQ-TEAM-004: hand the team over; the old leader becomes an officer. */
export function transfer(t: TeamState, actor: string, target: string) {
  assertMay(t, actor, 'transfer');
  const to = memberOf(t, target);
  if (!to || target === actor) throw new AppError('BAD_REQUEST', 'transfer to another member');
  memberOf(t, actor)!.role = 'officer';
  to.role = 'leader';
}

/** REQ-TEAM-004: only a team whose leader is the last member can be disbanded. */
export function disband(t: TeamState, cfg: TeamsConfig, actor: string, now: number) {
  assertMay(t, actor, 'disband');
  if (t.members.length > 1) throw new AppError('FORBIDDEN', 'remove or transfer to the other members first');
  removeMember(t, cfg, actor, now);
  t.disbanded = true;
}

export function updateTeam(m: Master, cfg: TeamsConfig, t: TeamState, actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy; emblem?: Emblem }) {
  if (patch.emblem !== undefined) {
    assertMay(t, actor, 'announce');
    t.emblem = validateEmblem(patch.emblem);
  }
  if (patch.joinPolicy !== undefined) {
    assertMay(t, actor, 'policy');
    t.joinPolicy = patch.joinPolicy;
    if (patch.joinPolicy === 'open') t.requests = []; // pending requests of an open team make no sense
  }
  if (patch.announcement !== undefined) {
    assertMay(t, actor, 'announce');
    t.announcement = validateAnnouncement(m, cfg, patch.announcement);
  }
}

// ------------------------------------------------------------------------------------- points

/** Records a member's latest standing (pushed by the player's object). Returns false for non-members. */
export function reportPoints(t: TeamState, playerId: string, season: string, points: number, displayName: string): boolean {
  const m = memberOf(t, playerId);
  if (!m) return false;
  if (season < m.season) return false; // late report of an older season
  m.season = season;
  m.points = points;
  m.displayName = displayName;
  return true;
}

/**
 * REQ-TEAM-005: what a member adds to the team in `season`: points earned while in the team
 * (points at join are not credited), capped per member so one strong player cannot carry a team.
 */
export function contribution(m: TeamMember, season: string, cap: number): number {
  if (m.season !== season) return 0;
  const base = m.baselineSeason === season ? m.baselinePoints : 0;
  return Math.max(0, Math.min(cap, m.points - base));
}

export const teamPoints = (t: TeamState, season: string, cap: number) => t.members.reduce((a, m) => a + contribution(m, season, cap), 0);

/** One membership period of a player (a leave and rejoin starts a new stint with a new baseline). */
export const stintKey = (m: Pick<TeamMember, 'playerId' | 'joinedAt'>) => `${m.playerId}@${m.joinedAt}`;

/** REQ-LEAGUE-003: contribution per stint this season — current members live, departed ones frozen at leave. */
export function teamStints(t: TeamState, season: string, cap: number): Record<string, number> {
  const out: Record<string, number> = t.leftStints?.season === season ? { ...t.leftStints.byKey } : {};
  for (const m of t.members) out[stintKey(m)] = contribution(m, season, cap);
  return out;
}

// ------------------------------------------------------------------------------------- season close

/** JST month "YYYY-MM" → the instant it ends (start of the next JST month). */
export function seasonEndMs(seasonId: string): number {
  const [y, mo] = seasonId.split('-').map(Number) as [number, number];
  return Date.UTC(y, mo, 1) - 9 * 3600_000;
}

/**
 * REQ-TEAM-007 (anti-hopping): a member is rewarded for a season only if they had joined at least
 * `rewardMinDays` before the season ended and were still in the team when it ended (a later departure
 * does not cost them the reward).
 */
export function eligibleMembers(t: TeamState, cfg: TeamsConfig, seasonId: string): string[] {
  const end = seasonEndMs(seasonId);
  const cutoff = end - cfg.rewardMinDays * DAY_MS;
  const ids = new Set<string>();
  for (const m of t.members) if (m.joinedAt <= cutoff) ids.add(m.playerId);
  for (const f of t.former) if (f.joinedAt <= cutoff && f.leftAt >= end) ids.add(f.playerId);
  return [...ids].sort();
}

export function teamRewardFor(cfg: TeamsConfig, rank: number | null, points: number): Reward | null {
  if (points <= 0) return null;
  for (const b of cfg.seasonRewards) if (b.maxRank === null || (rank !== null && rank <= b.maxRank)) return b.reward;
  return null;
}

/**
 * REQ-TEAM-008: one resumable step of paying a closed season. The eligible list is fixed on the first
 * call; `pay` must be idempotent (the player's object records the paid season).
 */
export async function closeSeasonStep(
  t: TeamState, cfg: TeamsConfig, seasonId: string, rank: number | null, total: number,
  pay: (playerId: string, close: TeamSeasonClose) => Promise<void>, batch: number, persist: () => Promise<void>,
  league: { cfg: LeagueConfig; place: LeaguePlace | null } | null = null,
): Promise<TeamSeasonClose> {
  let c = t.closes[seasonId];
  if (!c) {
    // members are paid when there is a team reward or a league reward (REQ-LEAGUE-004); the same tenure rule applies
    const place = league?.place ?? null;
    const any = teamRewardFor(cfg, rank, total) !== null || (league !== null && leagueRewardFor(league.cfg, place) !== null);
    c = { rank, total, eligible: any ? eligibleMembers(t, cfg, seasonId) : [], cursor: 0, done: false, league: place };
    t.closes[seasonId] = c;
    await persist();
  }
  const end = Math.min(c.eligible.length, c.cursor + batch);
  while (c.cursor < end) {
    await pay(c.eligible[c.cursor]!, c);
    c.cursor++;
    await persist();
  }
  if (c.cursor >= c.eligible.length) c.done = true;
  // keep only the last few closes
  const keys = Object.keys(t.closes).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 6))) delete t.closes[k];
  await persist();
  return c;
}

// ------------------------------------------------------------------------------------- season board

export interface TeamBoardRow { rank: number; teamId: string; name: string; points: number; members: number }
export interface TeamBoardFile { seasonId: string; board: 'teams'; generatedAt: number; total: number; entries: TeamBoardRow[] }

/** Points desc → reached earlier → team id. */
export function compareTeams(a: TeamSummary, b: TeamSummary) {
  return b.points - a.points || a.updatedAt - b.updatedAt || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0);
}

/** REQ-TEAM-009: season team ranking (teams with 0 points are not ranked). */
export function buildTeamBoard(seasonId: string, teams: TeamSummary[], now: number, topN: number) {
  const list = teams.filter((t) => t.season === seasonId && t.points > 0).sort(compareTeams);
  const ranks = new Map(list.map((t, i) => [t.teamId, { rank: i + 1, total: list.length, points: t.points }]));
  const file: TeamBoardFile = {
    seasonId, board: 'teams', generatedAt: now, total: list.length,
    entries: list.slice(0, topN).map((t, i) => ({ rank: i + 1, teamId: t.teamId, name: t.name, points: t.points, members: t.members })),
  };
  return { file, ranks };
}

// ------------------------------------------------------------------------------------- views

export interface TeamSummary {
  teamId: string; name: string; joinPolicy: JoinPolicy; members: number; points: number; season: string; updatedAt: number; emblem?: Emblem;
  /** REQ-LEAGUE-003: contribution per stint (teamStints); absent in summaries stored by older builds. */
  stints?: Record<string, number>;
}

export function teamSummary(t: TeamState, season: string, cap: number, now: number): TeamSummary {
  return { teamId: t.id, name: t.name, joinPolicy: t.joinPolicy, members: t.members.length, points: teamPoints(t, season, cap), season, updatedAt: now, emblem: t.emblem ?? defaultEmblem(t.id), stints: teamStints(t, season, cap) };
}

/** Public view; requests are shown only to the leader and officers. */
export function teamView(t: TeamState, cfg: TeamsConfig, season: string, viewer: string | null, now: number) {
  const role = viewer ? memberOf(t, viewer)?.role ?? null : null;
  gcRequests(t, cfg, now);
  return {
    teamId: t.id, name: t.name, joinPolicy: t.joinPolicy, announcement: t.announcement, createdAt: t.createdAt, emblem: t.emblem ?? defaultEmblem(t.id),
    disbanded: t.disbanded, season, points: teamPoints(t, season, cfg.memberPointsCap), maxMembers: cfg.maxMembers,
    members: t.members.map((m) => ({ playerId: m.playerId, displayName: m.displayName, role: m.role, joinedAt: m.joinedAt, contribution: contribution(m, season, cfg.memberPointsCap) })),
    myRole: role,
    requests: role === 'leader' || role === 'officer' ? t.requests.map((r) => ({ playerId: r.playerId, displayName: r.displayName, at: r.at })) : [],
  };
}

// ------------------------------------------------------------------------------------- player side

export interface PlayerTeamState {
  teamId: string | null; joinedAt: number | null;
  /** REQ-TEAM-007: no joining another team before this instant (set when leaving by choice). */
  cooldownUntil: number;
  /** Join in progress (prevents joining two teams concurrently). */
  joining: { teamId: string; at: number } | null;
  /** Pending join requests sent to approval-policy teams. */
  outgoing: { teamId: string; at: number }[];
  /** Seasons whose team reward was paid (REQ-TEAM-008 idempotency). */
  rewarded: string[];
}

export function ensureTeam(s: PlayerState): PlayerTeamState {
  return (s.team ??= { teamId: null, joinedAt: null, cooldownUntil: 0, joining: null, outgoing: [], rewarded: [] });
}

export const snapshotOf = (s: PlayerState): MemberSnapshot => ({ playerId: s.id, displayName: s.profile.displayName, season: s.season.id, points: s.season.points });

function assertFree(p: PlayerTeamState, now: number) {
  if (p.teamId) throw new AppError('ALREADY_IN_TEAM');
  if (now < p.cooldownUntil) throw new AppError('TEAM_COOLDOWN', `can join again after ${new Date(p.cooldownUntil).toISOString()}`);
}

/** Step 1 of a join on the player side: checks and a short lock. */
export function playerPrepareJoin(s: PlayerState, teamId: string, now: number): MemberSnapshot {
  const p = ensureTeam(s);
  assertFree(p, now);
  if (p.joining && p.joining.teamId !== teamId && now - p.joining.at < RESERVE_TTL_MS) throw new AppError('CONFLICT', 'another join is in progress');
  p.joining = { teamId, at: now };
  return snapshotOf(s);
}

export function playerCommitJoin(s: PlayerState, teamId: string, now: number) {
  const p = ensureTeam(s);
  if (p.teamId === teamId) return { teamId, joinedAt: p.joinedAt };
  if (p.teamId) throw new AppError('ALREADY_IN_TEAM');
  p.teamId = teamId;
  p.joinedAt = now;
  p.joining = null;
  p.outgoing = [];
  return { teamId, joinedAt: now };
}

export function playerAbortJoin(s: PlayerState, teamId: string) {
  const p = ensureTeam(s);
  if (p.joining?.teamId === teamId) p.joining = null;
}

export function playerAddOutgoing(s: PlayerState, cfg: TeamsConfig, teamId: string, now: number) {
  const p = ensureTeam(s);
  assertFree(p, now);
  p.outgoing = p.outgoing.filter((o) => now - o.at < cfg.requestTtlMs);
  if (p.outgoing.some((o) => o.teamId === teamId)) return snapshotOf(s);
  if (p.outgoing.length >= cfg.maxOutgoingRequests) throw new AppError('TEAM_LIMIT', `at most ${cfg.maxOutgoingRequests} pending requests`);
  p.outgoing.push({ teamId, at: now });
  return snapshotOf(s);
}

export function playerRemoveOutgoing(s: PlayerState, teamId: string) {
  const p = ensureTeam(s);
  p.outgoing = p.outgoing.filter((o) => o.teamId !== teamId);
}

/** The team removed this player (leave, kick or disband). Leaving by choice starts the cooldown. */
export function playerLeft(s: PlayerState, cfg: TeamsConfig, teamId: string, now: number, byChoice: boolean) {
  const p = ensureTeam(s);
  if (p.teamId !== teamId) return { changed: false };
  p.teamId = null;
  p.joinedAt = null;
  if (byChoice) p.cooldownUntil = now + cfg.rejoinCooldownMs;
  return { changed: true, cooldownUntil: p.cooldownUntil };
}

/**
 * REQ-TEAM-008 / REQ-LEAGUE-004: pays the team season reward and the league reward once per season
 * (both are marked by the same per-season entry, so a retried payout never pays either twice).
 */
export function playerTeamReward(
  s: PlayerState, cfg: TeamsConfig, seasonId: string, teamId: string, rank: number | null, total: number, now: number,
  league: { cfg: LeagueConfig; place: LeaguePlace | null } | null = null,
  give?: Give,
) {
  const p = ensureTeam(s);
  if (p.rewarded.includes(seasonId)) return { status: 'already' as const, reward: null, leagueReward: null };
  const reward = teamRewardFor(cfg, rank, total);
  const leagueReward = league ? leagueRewardFor(league.cfg, league.place) : null;
  p.rewarded.push(seasonId);
  if (p.rewarded.length > 24) p.rewarded.splice(0, p.rewarded.length - 24);
  // REQ-BOX-001: the service passes the gift box (`give`); absent = straight into the wallet
  const pay: Give = give ?? ((r, note, ref) => grantReward(s, r, now, note, ref));
  if (reward) pay(reward, `team ${teamId} season ${seasonId} rank ${rank ?? '-'}`, `team:${seasonId}`, 'team', rank);
  if (leagueReward && league?.place) {
    pay(leagueReward, `league ${seasonId} ${league.place.divisionId} place ${league.place.place} team ${teamId}`, `league:${seasonId}`, 'league', league.place.place);
  }
  return { status: 'rewarded' as const, reward, leagueReward };
}
