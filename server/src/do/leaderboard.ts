import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import {
  acceptEntry, boardKey, buildSnapshot, indexKey, newRolloverState, recordRolloverFailure, rolloverStep, seasonIsOver,
  type BoardFile, type RankInfo, type RolloverState, type SeasonEntry, type SnapshotIndex,
} from '../domain/leaderboard.js';
import { betterTa, buildTaBoards, type TaEntry } from '../domain/timeAttack.js';
import { buildTeamBoard, type TeamSummary } from '../domain/teams.js';

type TaRowDb = { player_id: string; track_id: string; time_ms: number; finish_tick: number; finish_frac: number; display_name: string; title_id: string | null; horse_name: string; updated_at: number };
import { unwrap, wrap, type Envelope } from './rpc.js';
import { DirtyTracker } from '../domain/dirty.js';
import { dismissRolloverItem, retryRolloverItem, rolloverDeadLetters, type DeadLetterItem, type RetryOutcome, type RolloverWithLog } from '../ops/deadLetter.js';
import { newlyDead, reportDeadLetters } from './deadLetters.js';

/** Wall-clock budget of one cron rollover call (the cron runs every 5 minutes). */
const ROLLOVER_BUDGET_MS = 20_000;

type EntryRow = { player_id: string; season_id: string; class_id: string; points: number; rating: number; races: number; display_name: string; title_id: string | null; updated_at: number };
type RankRow = { player_id: string; class_id: string; class_rank: number; class_total: number; rating_rank: number; rating_total: number };

/**
 * One season's standings (REQ-LB-*, REQ-SEASON-*). Named `lb:<seasonId>`, so seasons never contend.
 * Players' DOs push their standing after ranked races; the cron publishes snapshots to R2 (read by
 * the public GET endpoints without touching this object) and stores everyone's rank for "my rank".
 */
export class LeaderboardDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (player_id TEXT PRIMARY KEY, season_id TEXT NOT NULL, class_id TEXT NOT NULL, points INTEGER NOT NULL, rating INTEGER NOT NULL, races INTEGER NOT NULL, display_name TEXT NOT NULL, title_id TEXT, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ranks (player_id TEXT PRIMARY KEY, class_id TEXT NOT NULL, class_rank INTEGER NOT NULL, class_total INTEGER NOT NULL, rating_rank INTEGER NOT NULL, rating_total INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // time attack (REQ-TA-006): best verified run per player and track this season
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ta_entries (player_id TEXT NOT NULL, track_id TEXT NOT NULL, time_ms INTEGER NOT NULL, finish_tick INTEGER NOT NULL, finish_frac INTEGER NOT NULL, display_name TEXT NOT NULL, title_id TEXT, horse_name TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (player_id, track_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ta_ranks (player_id TEXT NOT NULL, track_id TEXT NOT NULL, rank INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (player_id, track_id))`);
    // teams (REQ-TEAM-009): one summary per team for this season, pushed by the TeamDOs
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_entries (team_id TEXT PRIMARY KEY, name TEXT NOT NULL, join_policy TEXT NOT NULL, members INTEGER NOT NULL, points INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS team_ranks (team_id TEXT PRIMARY KEY, rank INTEGER NOT NULL, total INTEGER NOT NULL, points INTEGER NOT NULL)`);
  }

  private teamSummaries(seasonId: string): TeamSummary[] {
    return this.sql.exec<{ team_id: string; name: string; join_policy: string; members: number; points: number; updated_at: number }>('SELECT * FROM team_entries').toArray()
      .map((r) => ({ teamId: r.team_id, name: r.name, joinPolicy: r.join_policy as TeamSummary['joinPolicy'], members: r.members, points: r.points, season: seasonId, updatedAt: r.updated_at }));
  }

  /** REQ-TEAM-009: latest summary of a team for this season (frozen once the season's rollover started). */
  async upsertTeam(s: TeamSummary): Promise<Envelope<boolean>> {
    return wrap(() => {
      const st = this.kvGet<RolloverState>('teamRollover');
      if (st && st.status !== 'open') return false;
      this.sql.exec(
        `INSERT INTO team_entries (team_id, name, join_policy, members, points, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, join_policy = excluded.join_policy, members = excluded.members, points = excluded.points,
           updated_at = excluded.updated_at WHERE excluded.updated_at >= team_entries.updated_at`,
        s.teamId, s.name, s.joinPolicy, s.members, s.points, s.updatedAt,
      );
      this.markDirty();
      return true;
    });
  }

  async teamRankOf(teamId: string): Promise<Envelope<{ rank: number; total: number; generatedAt: number | null } | null>> {
    return wrap(() => {
      const r = this.sql.exec<{ rank: number; total: number }>('SELECT rank, total FROM team_ranks WHERE team_id = ?', teamId).toArray()[0];
      return r ? { rank: r.rank, total: r.total, generatedAt: this.kvGet<number>('generatedAt') } : null;
    });
  }

  /**
   * REQ-TEAM-008: after the season ended, take the final team ranking and let every ranked team pay its
   * eligible members (one bounded, resumable step per cron run; a team that is not done holds the cursor).
   */
  async teamRolloverStep(seasonId: string, now: number): Promise<Envelope<RolloverState>> {
    return wrap(async () => {
      const deadBefore = rolloverDeadLetters(this.kvGet<RolloverState>('teamRollover'));
      try {
        return await this.teamRolloverRun(seasonId, now);
      } finally {
        await reportDeadLetters(this.env, 'team', seasonId, newlyDead(deadBefore, rolloverDeadLetters(this.kvGet<RolloverState>('teamRollover'))), now);
      }
    });
  }

  private async teamRolloverRun(seasonId: string, now: number): Promise<RolloverState> {
    {
      let st = this.kvGet<RolloverState>('teamRollover') ?? newRolloverState(seasonId);
      if (st.status === 'closed' || !seasonIsOver(seasonId, now)) return st;
      if (st.status === 'open') {
        st = { ...st, status: 'closing' };
        this.kvPut('teamRollover', st); // freezes team_entries first
        unwrap(await this.snapshot(seasonId, now, true)); // final team ranks
      }
      const batch = (await activeConfig(this.env)).master.progression.teams.rolloverBatch;
      const deadline = Date.now() + ROLLOVER_BUDGET_MS;
      // time-budgeted: keep taking batches until the season is done or this run's budget is spent
      while (st.status !== 'closed' && Date.now() < deadline) {
        const todo = this.sql.exec<{ team_id: string; rank: number; points: number }>('SELECT team_id, rank, points FROM team_ranks WHERE team_id > ? ORDER BY team_id LIMIT ?', st.cursor, batch).toArray();
        for (const t of todo) {
          const team = this.env.TEAMS.get(this.env.TEAMS.idFromName(t.team_id)) as unknown as { closeSeasonStep(s: string, r: number, p: number): Promise<Envelope<{ done: boolean }>> };
          let done = false;
          let error: string | null = null;
          try {
            done = unwrap(await team.closeSeasonStep(seasonId, t.rank, t.points)).done;
          } catch (e) {
            error = (e as Error).message;
          }
          if (!done) {
            // a team that is not done yet (its members are paid in bounded steps) holds the cursor; an
            // erroring one is retried a few runs and then dead-lettered so the teams after it get paid
            const next = { ...st };
            if (error === null || !recordRolloverFailure(next, t.team_id, error)) {
              if (error !== null) st = next;
              this.kvPut('teamRollover', st); // resume with this team next run
              return st;
            }
            st = next;
          } else if (st.failures?.[t.team_id]) {
            const f = { ...st.failures };
            delete f[t.team_id];
            st = { ...st, failures: f };
          }
          st = { ...st, cursor: t.team_id, processed: st.processed + (done ? 1 : 0), lastError: done ? null : st.lastError };
          this.kvPut('teamRollover', st);
        }
        if (todo.length < batch) st = { ...st, status: 'closed' };
        this.kvPut('teamRollover', st);
      }
      return st;
    }
  }

  private taEntries(seasonId: string, where = '', ...args: (string | number)[]): TaEntry[] {
    return this.sql.exec<TaRowDb>(`SELECT * FROM ta_entries ${where}`, ...args).toArray().map((r) => ({
      playerId: r.player_id, seasonId, trackId: r.track_id, timeMs: r.time_ms, finishTick: r.finish_tick, finishFrac: r.finish_frac,
      displayName: r.display_name, titleId: r.title_id, horseName: r.horse_name, updatedAt: r.updated_at,
    }));
  }

  /** REQ-TA-006: keep the faster run (a slower one never replaces a better entry). */
  async upsertTimeAttack(e: TaEntry): Promise<Envelope<boolean>> {
    return wrap(() => {
      if (!acceptEntry(e.seasonId, this.rollover(e.seasonId).status, { seasonId: e.seasonId } as SeasonEntry)) return false;
      const prev = this.taEntries(e.seasonId, 'WHERE player_id = ? AND track_id = ?', e.playerId, e.trackId)[0];
      if (!betterTa(prev, e)) return false;
      this.sql.exec(
        `INSERT INTO ta_entries (player_id, track_id, time_ms, finish_tick, finish_frac, display_name, title_id, horse_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id, track_id) DO UPDATE SET time_ms = excluded.time_ms, finish_tick = excluded.finish_tick, finish_frac = excluded.finish_frac,
           display_name = excluded.display_name, title_id = excluded.title_id, horse_name = excluded.horse_name, updated_at = excluded.updated_at`,
        e.playerId, e.trackId, e.timeMs, e.finishTick, e.finishFrac, e.displayName, e.titleId, e.horseName, e.updatedAt,
      );
      this.markDirty();
      return true;
    });
  }

  async taRankOf(trackId: string, playerId: string): Promise<Envelope<{ rank: number; total: number; generatedAt: number | null } | null>> {
    return wrap(() => {
      const r = this.sql.exec<{ rank: number; total: number }>('SELECT rank, total FROM ta_ranks WHERE player_id = ? AND track_id = ?', playerId, trackId).toArray()[0];
      return r ? { rank: r.rank, total: r.total, generatedAt: this.kvGet<number>('generatedAt') } : null;
    });
  }

  async taEntriesFor(seasonId: string, trackId: string, playerIds: string[]): Promise<Envelope<TaEntry[]>> {
    return wrap(() => {
      const ids = playerIds.slice(0, 200);
      if (!ids.length) return [];
      return this.taEntries(seasonId, `WHERE track_id = ? AND player_id IN (${ids.map(() => '?').join(',')})`, trackId, ...ids);
    });
  }

  private kvGet<T>(k: string): T | null {
    const r = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private kvPut(k: string, v: unknown) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }
  private rollover(seasonId: string): RolloverState { return this.kvGet<RolloverState>('rollover') ?? newRolloverState(seasonId); }
  private readonly dirty = new DirtyTracker({ get: <T>(k: string) => this.kvGet<T>(k), put: (k, v) => this.kvPut(k, v) });
  private markDirty() { this.dirty.mark(); }

  private entries(): SeasonEntry[] {
    return this.sql.exec<EntryRow>('SELECT * FROM entries').toArray().map((r) => ({
      playerId: r.player_id, seasonId: r.season_id, classId: r.class_id, points: r.points, rating: r.rating, races: r.races,
      displayName: r.display_name, titleId: r.title_id, updatedAt: r.updated_at,
    }));
  }

  async upsert(e: SeasonEntry): Promise<Envelope<boolean>> {
    return wrap(() => {
      if (!acceptEntry(e.seasonId, this.rollover(e.seasonId).status, e)) return false;
      this.sql.exec(
        `INSERT INTO entries (player_id, season_id, class_id, points, rating, races, display_name, title_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET class_id = excluded.class_id, points = excluded.points, rating = excluded.rating, races = excluded.races,
           display_name = excluded.display_name, title_id = excluded.title_id, updated_at = excluded.updated_at WHERE excluded.updated_at >= entries.updated_at`,
        e.playerId, e.seasonId, e.classId, e.points, e.rating, e.races, e.displayName, e.titleId, e.updatedAt,
      );
      this.markDirty();
      return true;
    });
  }

  /** REQ-LB-001: publish snapshot files and store ranks. Skipped when nothing changed (cheap cron). */
  async snapshot(seasonId: string, now: number, force = false): Promise<Envelope<{ published: boolean; files: number }>> {
    return wrap(async () => {
      if (this.dirty.begin(force) === null) return { published: false, files: 0 };
      const m = (await activeConfig(this.env)).master; // follow remote config (REQ-OPS-005)
      // the generation is taken right before the rows are read (no await in between): an upsert that
      // lands during the R2 writes below bumps it again and keeps the board dirty for the next run
      const gen = this.dirty.begin(true)!;
      const snap = buildSnapshot(seasonId, this.entries(), now, m.progression.leaderboard.topN);
      // time attack boards (REQ-TA-006) are published with the same snapshot and listed in the index
      const ta = buildTaBoards(seasonId, this.taEntries(seasonId), now, m.progression.timeAttack.topN);
      const idx = snap.files.find((f) => f.key === indexKey(seasonId))?.body as SnapshotIndex | undefined;
      for (const f of ta.files) {
        snap.files.unshift({ key: boardKey(seasonId, f.board), body: f.body as unknown as BoardFile });
        idx?.boards.push({ board: f.board, total: f.body.total, key: boardKey(seasonId, f.board) });
      }
      // team ranking (REQ-TEAM-009) is published with the same snapshot and listed in the index
      const tb = buildTeamBoard(seasonId, this.teamSummaries(seasonId), now, m.progression.teams.topN);
      snap.files.unshift({ key: boardKey(seasonId, 'teams'), body: tb.file as unknown as BoardFile });
      idx?.boards.push({ board: 'teams', total: tb.file.total, key: boardKey(seasonId, 'teams') });
      this.sql.exec('DELETE FROM team_ranks');
      for (const [tid, r] of tb.ranks) this.sql.exec('INSERT INTO team_ranks (team_id, rank, total, points) VALUES (?, ?, ?, ?)', tid, r.rank, r.total, r.points);
      this.sql.exec('DELETE FROM ta_ranks');
      for (const r of ta.ranks) this.sql.exec('INSERT INTO ta_ranks (player_id, track_id, rank, total) VALUES (?, ?, ?, ?)', r.playerId, r.trackId, r.rank, r.total);
      for (const f of snap.files) {
        await this.env.SNAPSHOTS.put(f.key, JSON.stringify(f.body), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' } });
      }
      this.sql.exec('DELETE FROM ranks');
      for (const [pid, r] of snap.ranks) {
        this.sql.exec('INSERT INTO ranks (player_id, class_id, class_rank, class_total, rating_rank, rating_total) VALUES (?, ?, ?, ?, ?, ?)', pid, r.classId, r.classRank, r.classTotal, r.ratingRank, r.ratingTotal);
      }
      this.dirty.end(gen);
      this.kvPut('generatedAt', now);
      return { published: true, files: snap.files.length };
    });
  }

  /** REQ-LB-003: the player's rank as of the last snapshot plus the live standing. */
  async rankOf(playerId: string): Promise<Envelope<unknown>> {
    return wrap(() => {
      const r = this.sql.exec<RankRow>('SELECT * FROM ranks WHERE player_id = ?', playerId).toArray()[0];
      const e = this.sql.exec<EntryRow>('SELECT * FROM entries WHERE player_id = ?', playerId).toArray()[0];
      const rank: RankInfo | null = r ? { classId: r.class_id, classRank: r.class_rank, classTotal: r.class_total, ratingRank: r.rating_rank, ratingTotal: r.rating_total } : null;
      return { rank, standing: e ? { classId: e.class_id, points: e.points, rating: e.rating, races: e.races } : null, generatedAt: this.kvGet<number>('generatedAt') };
    });
  }

  /** REQ-SEASON-001/003: one bounded, resumable rollover step (no-op while the season is running or once closed). */
  async rolloverStep(seasonId: string, now: number): Promise<Envelope<RolloverState>> {
    return wrap(async () => {
      const deadBefore = rolloverDeadLetters(this.kvGet<RolloverState>('rollover'));
      try {
        return await this.seasonRolloverRun(seasonId, now);
      } finally {
        await reportDeadLetters(this.env, 'season', seasonId, newlyDead(deadBefore, rolloverDeadLetters(this.kvGet<RolloverState>('rollover'))), now);
      }
    });
  }

  private async seasonRolloverRun(seasonId: string, now: number): Promise<RolloverState> {
    {
      let st = this.rollover(seasonId);
      if (st.status === 'closed' || !seasonIsOver(seasonId, now)) return st;
      if (st.status === 'open') {
        unwrap(await this.snapshot(seasonId, now, true)); // final standings → final ranks
        st = { ...st, status: 'closing' };
        this.kvPut('rollover', st);
      }
      const batch = (await activeConfig(this.env)).master.progression.leaderboard.rolloverBatch;
      const deadline = Date.now() + ROLLOVER_BUDGET_MS;
      const rankOfPlayer = (pid: string): RankInfo | undefined => {
        const r = this.sql.exec<RankRow>('SELECT * FROM ranks WHERE player_id = ?', pid).toArray()[0];
        return r ? { classId: r.class_id, classRank: r.class_rank, classTotal: r.class_total, ratingRank: r.rating_rank, ratingTotal: r.rating_total } : undefined;
      };
      // time-budgeted: keep taking batches until the season is closed, a player needs a retry, or the budget is spent
      while (st.status !== 'closed' && Date.now() < deadline) {
        const participants = this.sql.exec<{ player_id: string; class_id: string }>('SELECT player_id, class_id FROM entries WHERE player_id > ? AND races > 0 ORDER BY player_id LIMIT ?', st.cursor, batch)
          .toArray().map((r) => ({ playerId: r.player_id, classId: r.class_id }));
        const cur = st;
        st = await rolloverStep(cur, participants, rankOfPlayer, async (pid, rank) => {
          const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
          unwrap(await stub.invoke('closeSeason', [pid, seasonId, rank]));
          this.kvPut('rollover', { ...cur, cursor: pid }); // durable cursor after every player
        }, batch);
        this.kvPut('rollover', st);
        // a failed close is retried on the next run (not in a tight loop, so the attempt cap means "runs")
        if (st.lastError !== null) break;
      }
      return st;
    }
  }

  // ---- dead letters (REQ-OPS-041): players / teams set aside by the rollovers ----
  private dlKey(kind: 'season' | 'team') { return kind === 'season' ? 'rollover' : 'teamRollover'; }
  async dlList(kind: 'season' | 'team'): Promise<Envelope<DeadLetterItem[]>> {
    return wrap(() => rolloverDeadLetters(this.kvGet<RolloverState>(this.dlKey(kind))));
  }
  async dlRetry(kind: 'season' | 'team', seasonId: string, itemId: string): Promise<Envelope<RetryOutcome>> {
    return wrap(async () => {
      const st = this.kvGet<RolloverWithLog>(this.dlKey(kind));
      if (!st) return { ok: false, error: 'no rollover state' };
      const run = kind === 'season'
        ? async () => {
          const r = this.sql.exec<RankRow>('SELECT * FROM ranks WHERE player_id = ?', itemId).toArray()[0];
          const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(itemId)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
          unwrap(await stub.invoke('closeSeason', [itemId, seasonId, r ? r.class_rank : null]));
        }
        : async () => {
          const t = this.sql.exec<{ rank: number; points: number }>('SELECT rank, points FROM team_ranks WHERE team_id = ?', itemId).toArray()[0];
          const team = this.env.TEAMS.get(this.env.TEAMS.idFromName(itemId)) as unknown as { closeSeasonStep(s: string, r: number | null, p: number): Promise<Envelope<{ done: boolean }>> };
          // a team pays its members in bounded steps; keep stepping (each step is idempotent) until done
          for (let i = 0; i < 50; i++) if (unwrap(await team.closeSeasonStep(seasonId, t ? t.rank : null, t ? t.points : 0)).done) return;
          throw new Error('team payout did not finish in 50 steps');
        };
      const out = await retryRolloverItem(st, itemId, run);
      this.kvPut(this.dlKey(kind), out.st);
      return out.outcome;
    });
  }
  async dlDismiss(kind: 'season' | 'team', itemId: string, by: string, note: string, now: number): Promise<Envelope<boolean>> {
    return wrap(() => {
      const st = this.kvGet<RolloverWithLog>(this.dlKey(kind));
      if (!st) return false;
      this.kvPut(this.dlKey(kind), dismissRolloverItem(st, itemId, by, note, now));
      return true;
    });
  }
}
