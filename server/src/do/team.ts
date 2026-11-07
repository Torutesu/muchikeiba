import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import type { Master } from '../domain/master.js';
import { loadMaster } from '../domain/master.js';
import { TeamCore } from '../domain/teamService.js';
import type { LeaguePlace } from '../domain/league.js';
import { closeSeasonStep, type JoinPolicy, type MemberSnapshot, type TeamState, type TeamSummary } from '../domain/teams.js';
import { jstMonthKey } from '../domain/time.js';
import { newFeed, type FeedRace, type TeamFeedState } from '../domain/teamFeed.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

type Rpc = Record<string, (...a: unknown[]) => Promise<Envelope<unknown>>>;

/**
 * One 支部 = one Durable Object, named by its team id (REQ-TEAM-*). Membership changes of a team are
 * serialized here and never contend with other teams, so the design scales with the number of teams.
 * After every change the team's summary goes to the directory (search) and to the current season's
 * LeaderboardDO (team ranking), best effort.
 */
export class TeamDO extends DurableObject<Env> {
  private core: TeamCore;
  private master: Master = loadMaster();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new TeamCore(null, () => this.master);
    ctx.blockConcurrencyWhile(async () => {
      this.core.state = (await ctx.storage.get<TeamState>('team')) ?? null;
      this.core.feed = (await ctx.storage.get<TeamFeedState>('feed')) ?? newFeed();
    });
  }

  private async save() {
    // REQ-TEAMFEED-*: the feed (ring buffer of the last items) is stored under its own key
    if (this.core.state) await this.ctx.storage.put({ team: this.core.state, feed: this.core.feed });
    else await this.ctx.storage.put('feed', this.core.feed);
  }

  /** Runs one operation all-or-nothing, persists, then publishes the summary. */
  private run<T>(f: (c: TeamCore) => T, publish = true): Promise<Envelope<T>> {
    return wrap(async () => {
      this.master = (await activeConfig(this.env)).master;
      const before = this.core.state ? structuredClone(this.core.state) : null;
      const feedBefore = structuredClone(this.core.feed);
      let r: T;
      try {
        r = f(this.core);
      } catch (e) {
        this.core.state = before;
        this.core.feed = feedBefore;
        throw e;
      }
      await this.save();
      if (publish) await this.publish();
      return r;
    });
  }

  private async publish() {
    const t = this.core.state;
    if (!t) return;
    try {
      const dir = this.env.TEAM_DIRECTORY.get(this.env.TEAM_DIRECTORY.idFromName('global')) as unknown as Rpc;
      if (t.disbanded) {
        unwrap(await dir.remove!(t.id));
        return;
      }
      const s = this.core.summary();
      unwrap(await dir.upsert!(s));
      const lb = this.env.LEADERBOARD.get(this.env.LEADERBOARD.idFromName(`lb:${s.season}`)) as unknown as Rpc;
      unwrap(await lb.upsertTeam!(s));
    } catch (e) {
      console.error('team summary publish failed', t.id, (e as Error).message); // next change republishes
    }
  }

  create(teamId: string, init: { name: string; leader: MemberSnapshot; joinPolicy: JoinPolicy; announcement: string }) { return this.run((c) => c.create(teamId, init)); }
  view(viewer: string | null) { return this.run((c) => c.view(viewer), false); }
  reserve(playerId: string) { return this.run((c) => c.reserve(playerId), false); }
  release(playerId: string) { return this.run((c) => c.release(playerId), false); }
  commit(m: MemberSnapshot) { return this.run((c) => c.commit(m)); }
  request(playerId: string, displayName: string) { return this.run((c) => c.request(playerId, displayName), false); }
  checkRequest(actor: string, applicant: string) { return this.run((c) => c.checkRequest(actor, applicant), false); }
  dropRequest(playerId: string) { return this.run((c) => c.dropRequest(playerId), false); }
  decline(actor: string, applicant: string) { return this.run((c) => c.decline(actor, applicant), false); }
  leave(playerId: string) { return this.run((c) => c.leave(playerId)); }
  kick(actor: string, target: string) { return this.run((c) => c.kick(actor, target)); }
  setRole(actor: string, target: string, role: 'officer' | 'member') { return this.run((c) => c.setRole(actor, target, role), false); }
  transfer(actor: string, target: string) { return this.run((c) => c.transfer(actor, target), false); }
  update(actor: string, patch: { announcement?: string; joinPolicy?: JoinPolicy }) { return this.run((c) => c.update(actor, patch)); }
  disband(actor: string) { return this.run((c) => c.disband(actor)); }
  managers() { return this.run((c) => c.managers(), false); }
  /** REQ-TEAM-005: a member's latest standing (pushed by the player's object). */
  reportPoints(playerId: string, seasonId: string, points: number, displayName: string) {
    return this.run((c) => c.reportPoints(playerId, seasonId, points, displayName));
  }

  // REQ-TEAMFEED-*: the team feed (the summary does not change, so nothing is published)
  feedPost(playerId: string, stampId: string) { return this.run((c) => c.feedPost(playerId, stampId), false); }
  feedRace(playerId: string, race: FeedRace) { return this.run((c) => c.feedRace(playerId, race), false); }
  feedReact(playerId: string, seq: number, stampId: string | null) { return this.run((c) => c.feedReact(playerId, seq, stampId), false); }
  feedReport(playerId: string, seq: number) { return this.run((c) => c.feedReport(playerId, seq), false); }
  feedPage(viewer: string, muted: string[], before: number | null, limit: number | null) { return this.run((c) => c.feedPage(viewer, muted, before, limit), false); }
  feedForget(playerId: string) { return this.run((c) => c.feedForget(playerId), false); }

  /** REQ-TEAM-008: pay a closed season's team reward to eligible members (resumable; called by the season board). */
  async closeSeasonStep(seasonId: string, rank: number | null, total: number, league: LeaguePlace | null = null): Promise<Envelope<{ done: boolean; paid: number; eligible: number }>> {
    return wrap(async () => {
      const t = this.core.state;
      if (!t) return { done: true, paid: 0, eligible: 0 };
      const prog = (await activeConfig(this.env)).master.progression;
      const cfg = prog.teams;
      const c = await closeSeasonStep(t, cfg, seasonId, rank, total, async (pid, close) => {
        const p = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
        unwrap(await p.invoke('teamSeasonReward', [pid, seasonId, t.id, close.rank, close.total, close.league ?? null]));
      }, cfg.rolloverBatch, () => this.save(), { cfg: prog.league, place: league });
      return { done: c.done, paid: c.cursor, eligible: c.eligible.length };
    });
  }
}

type DirRow = { team_id: string; name: string; join_policy: string; members: number; points: number; season: string; updated_at: number };

/**
 * Team search/discovery (REQ-TEAM-009), singleton `global`. Rows are small summaries pushed by the
 * TeamDOs; SQLite LIKE search over names is fine at this scale (it is not on any race path).
 */
export class TeamDirectoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL, join_policy TEXT NOT NULL, members INTEGER NOT NULL, points INTEGER NOT NULL, season TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  }

  async upsert(s: TeamSummary): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec(
        `INSERT INTO teams (team_id, name, join_policy, members, points, season, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, join_policy = excluded.join_policy, members = excluded.members, points = excluded.points,
           season = excluded.season, updated_at = excluded.updated_at WHERE excluded.updated_at >= teams.updated_at`,
        s.teamId, s.name, s.joinPolicy, s.members, s.points, s.season, s.updatedAt,
      );
      return true;
    });
  }

  async remove(teamId: string): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('DELETE FROM teams WHERE team_id = ?', teamId);
      return true;
    });
  }

  /** Name contains `query` (or exact id); otherwise the most active teams of this season. */
  async search(query: string, limit: number): Promise<Envelope<TeamSummary[]>> {
    return wrap(() => {
      const season = jstMonthKey(Date.now());
      const n = Math.max(1, Math.min(50, limit));
      const like = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const rows = query
        ? this.sql.exec<DirRow>("SELECT * FROM teams WHERE name LIKE ? ESCAPE '\\' OR team_id = ? ORDER BY members DESC, updated_at DESC LIMIT ?", like, query, n).toArray()
        : this.sql.exec<DirRow>('SELECT * FROM teams ORDER BY (season = ?) DESC, points DESC, members DESC LIMIT ?', season, n).toArray();
      return rows.map((r) => ({ teamId: r.team_id, name: r.name, joinPolicy: r.join_policy as JoinPolicy, members: r.members, points: r.season === season ? r.points : 0, season: r.season, updatedAt: r.updated_at }));
    });
  }
}
