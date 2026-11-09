import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import { AppError } from '../domain/errors.js';
import { cryptoRng } from '../domain/rng.js';
import { liveRaceOf } from '../domain/spectate.js';
import {
  assembleTournament, cancelTournament, dismissPayout, newTournament, playerView, playerViewWithTicket, publicView, register, retryPayout,
  stepTournament, summaryOf, tournamentCore, tournamentDeadLetters, unregister, TOURNAMENT_LIST_KEEP_MS, forgetRegistrant, closingSoon,
  type Heat, type HeatOutcome, type Payout, type PersistHint, type Registrant, type Standing, type StoredCore, type TournamentDef,
  type TournamentPorts, type TournamentState, type TournamentSummary,
} from '../domain/tournaments.js';
import type { TournamentEntryInfo } from '../domain/tournamentService.js';
import type { DeadLetterItem, RetryOutcome } from '../ops/deadLetter.js';
import type { RaceEntry } from '../http/app.js';
import { assignmentsFor, createRace, TICKET_TTL_MS } from '../race/orchestrate.js';
import { signTicket } from '../http/ticket.js';
import type { RaceStartConfig } from '../domain/schemas.js';
import { reportDeadLetters } from './deadLetters.js';
import { DELETED_PLAYER_NAME } from '../domain/accountDeletion.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

type Rpc = Record<string, (...a: unknown[]) => Promise<unknown>>;
type State = TournamentState<RaceEntry>;

/** R2 key of a tournament's public view (bracket, standings, history). */
export const tournamentSnapshotKey = (id: string) => `tournaments/${id}.json`;

/**
 * REQ-TOUR-*: one tournament = one Durable Object `tour:<id>`; the instance named `index` keeps the list.
 * Alarms drive the schedule (registration close → heats → rounds → prizes) through the pure
 * stepTournament(); the cron also wakes active tournaments as a fallback (REQ-TOUR-005).
 *
 * Storage (QA r7 #4, REQ-TOUR-011): registrations, heats and payouts are one SQLite row each and the
 * standings one value, so nothing grows past the 2 MB value limit with the field and a step only rewrites
 * the rows it changed. The small core (status, round headers) is one JSON value. Race tickets are never
 * stored: /me mints the player's ticket on demand.
 */
export class TournamentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private state: State | null = null;
  private stepping = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS registrants (player_id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS heats (id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS payouts (player_id TEXT PRIMARY KEY, v TEXT NOT NULL)');
    ctx.blockConcurrencyWhile(async () => {
      const core = this.kvGet<StoredCore>('state');
      if (!core) return;
      const rows = <T>(q: string) => this.sql.exec<{ v: string }>(q).toArray().map((r) => JSON.parse(r.v) as T);
      const registrants: State['registrants'] = {};
      for (const r of rows<Registrant<RaceEntry>>('SELECT v FROM registrants')) registrants[r.playerId] = r;
      const { state, legacyInline } = assembleTournament<RaceEntry>(core, {
        registrants, heats: rows<Heat>('SELECT v FROM heats'), payouts: rows<Payout>('SELECT v FROM payouts'), standings: this.kvGet<Standing[]>('standings'),
      });
      this.state = state;
      if (legacyInline) this.persistState({ heats: state.rounds.flatMap((r) => r.heats), payouts: Object.values(state.payouts), standings: true });
    });
  }

  private kvGet<T>(k: string): T | null {
    const r = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return r ? (JSON.parse(r.v) as T) : null;
  }
  private kvPut(k: string, v: unknown) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  /** Writes the core and the rows named in `hint` (see PersistHint). */
  private persistState(hint?: PersistHint) {
    if (!this.state) return;
    this.kvPut('state', tournamentCore(this.state));
    for (const h of hint?.heats ?? []) this.sql.exec('INSERT INTO heats (id, v) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v', h.id, JSON.stringify(h));
    for (const p of hint?.payouts ?? []) this.sql.exec('INSERT INTO payouts (player_id, v) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET v = excluded.v', p.playerId, JSON.stringify(p));
    if (hint?.standings) this.kvPut('standings', this.state.standings);
  }

  /** REQ-TOUR-009: the player's own race ticket, minted from the heat's raceId/slot/start (same as at creation). */
  private mint = (seat: { raceId: string; slot: number; startAtMs: number }, playerId: string) =>
    signTicket({ raceId: seat.raceId, slot: seat.slot, playerId, exp: seat.startAtMs + TICKET_TTL_MS }, this.env.TICKET_SECRET);

  private stub(ns: DurableObjectNamespace, name: string) { return ns.get(ns.idFromName(name)) as unknown as Rpc; }
  private player(pid: string) { return this.stub(this.env.PLAYER, pid) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> }; }

  private ports(): TournamentPorts<RaceEntry> {
    return {
      refreshEntry: async (r) => {
        const e = unwrap(await this.player(r.playerId).invoke('tournamentEntry', [r.playerId, r.horseId])) as TournamentEntryInfo;
        return { entry: e.entry as unknown as RaceEntry, info: e.info };
      },
      createHeat: async (spec) => {
        const cfg = await activeConfig(this.env);
        const now = Date.now();
        const created = await createRace(cfg.master, {
          ruleset: cfg.ruleset, mode: 'tournament', humans: spec.entries as RaceEntry[], cpuCount: spec.cpuCount, cpuLevel: spec.cpuLevel,
          rng: cryptoRng, now, ticketSecret: this.env.TICKET_SECRET, trackId: spec.heat.trackId, startAtMs: spec.startAtMs, statCap: spec.statCap,
          raceId: spec.raceId, // deterministic per heat attempt (QA r7 #5)
        });
        const room = this.stub(this.env.RACE_ROOM, spec.raceId) as unknown as { init(o: unknown): Promise<{ config: RaceStartConfig; startAtMs: number; existed: boolean }> };
        // init is idempotent: when a resumed attempt finds the room already made, that room's config and start win
        const actual = await room.init({ config: created.config, startAtMs: created.startAtMs, ratings: created.ratings, visuals: created.visuals });
        const race = actual.existed ? { ...created, config: actual.config, startAtMs: actual.startAtMs, assignments: await assignmentsFor(actual.config, actual.startAtMs, this.env.TICKET_SECRET) } : created;
        const title = `${spec.tournamentName} ${spec.final ? '決勝' : `${spec.heat.round + 1}回戦 第${spec.heat.index + 1}組`}`;
        const live = liveRaceOf(race, { title, tournamentId: spec.tournamentId })!;
        unwrap((await this.stub(this.env.MATCHMAKER, 'ranked-jp').registerLiveRace!(live, race.assignments)) as Envelope<unknown>);
        return { raceId: spec.raceId, startAtMs: race.startAtMs, slots: Object.fromEntries(Object.entries(race.assignments).map(([p, a]) => [p, a.slot])) };
      },
      heatResult: async (raceId) => (await (this.stub(this.env.RACE_ROOM, raceId) as unknown as { heatResult(): Promise<HeatOutcome | null> }).heatResult()),
      notify: async (pid, templateId, vars) => { unwrap(await this.player(pid).invoke('queuePush', [pid, templateId, vars])); },
      award: async (pid, tid, rank, reward, name, horseId) => { unwrap(await this.player(pid).invoke('tournamentClose', [pid, tid, rank, reward, name, horseId ?? null])); },
    };
  }

  private async publish(now: number) {
    const t = this.state;
    if (!t) return;
    try {
      await this.env.SNAPSHOTS.put(tournamentSnapshotKey(t.def.id), JSON.stringify(publicView(t, now)), { httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' } });
    } catch (e) { console.error('tournament publish failed', t.def.id, (e as Error).message); }
    try {
      unwrap((await this.stub(this.env.TOURNAMENTS!, 'index').indexUpsert!(summaryOf(t, now))) as Envelope<unknown>);
    } catch (e) { console.error('tournament index update failed', t.def.id, (e as Error).message); }
  }

  private async step(now: number) {
    const t = this.state;
    if (!t || this.stepping) return;
    this.stepping = true;
    try {
      const r = await stepTournament(t, now, this.ports(), async (hint) => { this.persistState(hint); });
      if (r.log.length) console.log('tournament', t.def.id, r.log.join(' '));
      if (r.changed) await this.publish(now);
      if (r.newlyDead.length) await reportDeadLetters(this.env, 'tournament', t.def.id, r.newlyDead, now);
      if (r.wakeAt !== null) await this.ctx.storage.setAlarm(r.wakeAt);
    } finally {
      this.stepping = false;
    }
  }

  private need(): State {
    if (!this.state) throw new AppError('NOT_FOUND', 'no such tournament');
    return this.state;
  }

  // ------------------------------------------------------------------------------- tournament instance

  async create(def: TournamentDef, by: string, now: number): Promise<Envelope<unknown>> {
    return wrap(async () => {
      if (this.state) {
        if (JSON.stringify(this.state.def) === JSON.stringify(def)) return publicView(this.state, now); // idempotent retry
        throw new AppError('CONFLICT', 'a tournament with this id already exists');
      }
      this.state = newTournament<RaceEntry>(def, by, now);
      this.persistState();
      await this.publish(now);
      await this.ctx.storage.setAlarm(Math.max(now + 1_000, Math.min(def.registrationOpensAtMs, def.registrationClosesAtMs)));
      return publicView(this.state, now);
    });
  }

  async view(now: number): Promise<Envelope<unknown>> { return wrap(() => (this.state ? publicView(this.state, now) : null)); }
  async me(playerId: string, now: number): Promise<Envelope<unknown>> { return wrap(() => playerViewWithTicket(this.need(), playerId, now, this.mint)); }

  async register(playerId: string, horseId: string, e: TournamentEntryInfo, now: number): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const t = this.need();
      const reg: Registrant<RaceEntry> = { playerId, displayName: e.displayName, horseId, rating: Math.round(e.entry.rating.r), registeredAt: now, entry: e.entry as unknown as RaceEntry };
      const out = register(t, reg, e.info, now);
      this.sql.exec('INSERT INTO registrants (player_id, v) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET v = excluded.v', playerId, JSON.stringify(t.registrants[playerId]));
      this.persistState();
      if (!out.existing) await this.publish(now);
      return { ...out, ...playerView(t, playerId, now) };
    });
  }

  async unregister(playerId: string, now: number): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const t = this.need();
      const removed = unregister(t, playerId, now);
      if (removed) {
        this.sql.exec('DELETE FROM registrants WHERE player_id = ?', playerId);
        this.persistState();
        await this.publish(now);
      }
      return { removed, ...playerView(t, playerId, now) };
    });
  }

  /** REQ-UXS-040: account deletion (see forgetRegistrant). */
  async forgetPlayer(playerId: string, now: number): Promise<Envelope<string>> {
    return wrap(async () => {
      if (!this.state) return 'none';
      const t = this.state;
      const r = forgetRegistrant(t, playerId, now, DELETED_PLAYER_NAME);
      if (r === 'removed') this.sql.exec('DELETE FROM registrants WHERE player_id = ?', playerId);
      if (r === 'anonymized') this.sql.exec('UPDATE registrants SET v = ? WHERE player_id = ?', JSON.stringify(t.registrants[playerId]), playerId);
      if (r !== 'none') { this.persistState(); await this.publish(now); }
      return r;
    });
  }

  /**
   * REQ-UXS-012: once per tournament, when registration closes within `leadMs`: the entry conditions and the
   * registered players (the cron nudges eligible players who have not registered). Null when not due / already done.
   */
  async closingNudge(now: number, leadMs: number): Promise<Envelope<{ tournamentId: string; name: string; classIds: string[] | null; minRankedRaces: number; minutes: number; registered: string[] } | null>> {
    return wrap(() => {
      const t = this.state;
      if (!t || !closingSoon(t, now, leadMs) || this.kvGet<boolean>('closingNudged')) return null;
      this.kvPut('closingNudged', true);
      return {
        tournamentId: t.def.id, name: t.def.name, classIds: t.def.entry.classIds, minRankedRaces: t.def.entry.minRankedRaces,
        minutes: Math.max(1, Math.round((t.def.registrationClosesAtMs - now) / 60_000)), registered: Object.keys(t.registrants),
      };
    });
  }

  async cancel(reason: string, now: number): Promise<Envelope<unknown>> {
    return wrap(async () => {
      const t = this.need();
      const changed = cancelTournament(t, reason, now);
      if (changed) { this.persistState(); await this.publish(now); }
      return publicView(t, now);
    });
  }

  /** Cron fallback (REQ-TOUR-005): make sure an active tournament has its alarm. */
  async wake(now: number): Promise<Envelope<unknown>> {
    return wrap(async () => {
      if (!this.state) return { status: 'none' };
      if ((await this.ctx.storage.getAlarm()) === null) await this.step(now);
      return { status: this.state.status };
    });
  }

  override async alarm() {
    await this.step(Date.now());
  }

  // ---- dead letters (REQ-OPS-041): prizes that could not be paid past the retry budget ----
  async dlList(): Promise<Envelope<DeadLetterItem[]>> { return wrap(() => tournamentDeadLetters(this.state)); }
  async dlRetry(playerId: string): Promise<Envelope<RetryOutcome>> {
    return wrap(async () => {
      const t = this.need();
      const out = await retryPayout(t, playerId, this.ports().award, Date.now());
      const p = t.payouts[playerId];
      this.persistState(p ? { payouts: [p] } : undefined);
      if (out.ok) await this.publish(Date.now());
      return out;
    });
  }
  async dlDismiss(playerId: string, by: string, note: string, now: number): Promise<Envelope<boolean>> {
    return wrap(() => {
      const t = this.need();
      const ok = dismissPayout(t, playerId, by, note, now);
      const p = t.payouts[playerId];
      this.persistState(p ? { payouts: [p] } : undefined);
      return ok;
    });
  }

  // ------------------------------------------------------------------------------------ index instance

  async indexUpsert(s: TournamentSummary): Promise<Envelope<unknown>> {
    return wrap(() => {
      const idx = this.kvGet<Record<string, TournamentSummary>>('index') ?? {};
      const cur = idx[s.id];
      if (cur && cur.updatedAt > s.updatedAt) return { ok: true, stale: true };
      idx[s.id] = s;
      const now = Date.now();
      for (const [k, v] of Object.entries(idx)) if (v.finishedAt !== null && now - v.finishedAt > TOURNAMENT_LIST_KEEP_MS) delete idx[k];
      this.kvPut('index', idx);
      return { ok: true };
    });
  }

  async indexList(): Promise<Envelope<TournamentSummary[]>> {
    return wrap(() => Object.values(this.kvGet<Record<string, TournamentSummary>>('index') ?? {}));
  }
}
