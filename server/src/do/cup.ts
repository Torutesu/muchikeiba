import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { activeConfig } from '../ops/activeConfig.js';
import { loadMaster, type Master } from '../domain/master.js';
import { AppError } from '../domain/errors.js';
import { cupCodeShard, cupExpiredForGood, cupWakeAt, type CupCancelReason, type CupCreateInput, type CupEntrant, type CupState } from '../domain/hostedCups.js';
import { CupRunner, type CupPorts } from '../domain/hostedCupService.js';
import type { HeatOutcome } from '../domain/tournaments.js';
import type { RaceEntry, PlayerMethod } from '../http/app.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

type Rpc = Record<string, (...a: unknown[]) => Promise<unknown>>;
type State = CupState<RaceEntry>;

/** Instance names: one per cup, and the code index shards (first character of the code). */
export const cupObjectName = (cupId: string) => `cup:${cupId}`;
export const cupCodeObjectName = (code: string) => `cupcode:${cupCodeShard(code)}`;

/**
 * REQ-CUP-* (§42): one hosted cup = one Durable Object `cup:<cupId>` (the state is one small JSON value: at most 12
 * entrants, 50 invitees, 3 races and their attempts). The same class serves the join-code index as `cupcode:<c>`.
 * The alarm polls a running race's room, closes the window, retries close notices and finally removes the cup.
 */
export class CupDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private state: State | null = null;
  private master: Master = loadMaster();
  private readonly runner: CupRunner<RaceEntry>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, cup_id TEXT NOT NULL, at INTEGER NOT NULL)');
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', 'state').toArray()[0];
    this.state = row ? (JSON.parse(row.v) as State) : null;
    this.runner = new CupRunner<RaceEntry>(() => this.master, () => this.state, (c) => this.write(c), this.ports(), Date.now);
  }

  private write(c: State) {
    this.state = c;
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'state', JSON.stringify(c));
  }

  private stub(ns: DurableObjectNamespace, name: string) { return ns.get(ns.idFromName(name)) as unknown as Rpc; }
  private player(pid: string) { return this.stub(this.env.PLAYER, pid) as unknown as { invoke(m: PlayerMethod, a: unknown[]): Promise<Envelope<unknown>> }; }

  private ports(): CupPorts<RaceEntry> {
    return {
      refreshEntry: async (pid, horseId) => unwrap(await this.player(pid).invoke('raceEntry', [pid, horseId])) as RaceEntry,
      startRace: async (spec) => unwrap((await this.stub(this.env.MATCHMAKER, 'ranked-jp').cupStart!({ raceId: spec.raceId, playerIds: spec.playerIds, entries: spec.entries, conditions: spec.conditions })) as Envelope<{ raceId: string; startAtMs: number }>),
      raceOutcome: async (raceId) => (await this.stub(this.env.RACE_ROOM, raceId).heatResult!()) as HeatOutcome | null,
      notifyClosed: async (pid, notice) => { unwrap(await this.player(pid).invoke('cupClosed', [pid, notice])); },
      notifyStarted: async (pid, notice) => { unwrap(await this.player(pid).invoke('cupStarted', [pid, notice])); }, // §42.7 × §40
      releaseCode: async (code, cupId) => { unwrap((await this.stub(this.env.CUPS!, cupCodeObjectName(code)).codeRelease!(code, cupId)) as Envelope<boolean>); },
    };
  }

  /** Every call runs on the active config (REQ-OPS-005) and reschedules the alarm afterwards. */
  private async run<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
    this.master = (await activeConfig(this.env)).master;
    const out = await wrap(fn);
    await this.schedule();
    return out;
  }

  private async schedule() {
    if (!this.state) return;
    const at = cupWakeAt(this.master, this.state, Date.now());
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  // ------------------------------------------------------------------------------------------- one cup

  async create(c: State, def: CupCreateInput) { return this.run(() => this.runner.create(c, def)); }
  async get(): Promise<Envelope<State | null>> { return wrap(() => this.state); }
  async join(e: CupEntrant<RaceEntry>) { return this.run(() => this.runner.join(e)); }
  async leave(playerId: string) { return this.run(() => this.runner.leave(playerId)); }
  async invite(by: string, ids: string[]) { return this.run(() => this.runner.invite(by, ids)); }
  async start(by: string) { return this.run(() => this.runner.start(by)); }
  async cancel(reason: CupCancelReason) { return this.run(() => this.runner.cancel(reason)); }
  async forget(playerId: string, anonName: string) { return this.run(() => this.runner.forget(playerId, anonName)); }

  override async alarm() {
    this.master = (await activeConfig(this.env)).master;
    if (!this.state) return;
    if (cupExpiredForGood(this.master, this.state, Date.now())) {
      // REQ-CUP-012: kept keepDays after it closed, then removed (the players keep their result in their history)
      this.state = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    try { await this.runner.tick(); } catch (e) { console.error('cup tick failed', this.state?.id, (e as Error).message); }
    await this.schedule();
  }

  // ------------------------------------------------------------------------------------------- code index

  async codeClaim(code: string, cupId: string): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO codes (code, cup_id, at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING', code, cupId, Date.now());
      return this.sql.exec<{ cup_id: string }>('SELECT cup_id FROM codes WHERE code = ?', code).toArray()[0]?.cup_id === cupId;
    });
  }
  async codeLookup(code: string): Promise<Envelope<string | null>> {
    return wrap(() => this.sql.exec<{ cup_id: string }>('SELECT cup_id FROM codes WHERE code = ?', code).toArray()[0]?.cup_id ?? null);
  }
  async codeRelease(code: string, cupId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM codes WHERE code = ? AND cup_id = ?', code, cupId); return true; });
  }
}

/** The backend the HTTP service uses (index.ts). */
export function durableCupBackend(env: Env) {
  const ns = env.CUPS!;
  const s = (name: string) => ns.get(ns.idFromName(name)) as unknown as Rpc;
  const cup = (id: string) => s(cupObjectName(id));
  const call = async <T>(p: Promise<unknown>) => unwrap(await (p as Promise<Envelope<T>>));
  return {
    claimCode: (code: string, cupId: string) => call<boolean>(s(cupCodeObjectName(code)).codeClaim!(code, cupId)),
    releaseCode: async (code: string, cupId: string) => { await call<boolean>(s(cupCodeObjectName(code)).codeRelease!(code, cupId)); },
    lookupCode: (code: string) => call<string | null>(s(cupCodeObjectName(code)).codeLookup!(code)),
    create: (state: State, def: CupCreateInput) => call<{ state: State; created: boolean }>(cup(state.id).create!(state, def)),
    get: (id: string) => call<State | null>(cup(id).get!()),
    join: (id: string, e: CupEntrant<RaceEntry>) => call<{ joined: boolean; state: State }>(cup(id).join!(e)),
    leave: (id: string, pid: string) => call<{ left: boolean; cancelled: boolean; state: State }>(cup(id).leave!(pid)),
    invite: (id: string, by: string, ids: string[]) => call<{ added: string[]; state: State }>(cup(id).invite!(by, ids)),
    start: (id: string, by: string) => call<{ raceId: string; raceIndex: number; startAtMs: number; cancelled: boolean }>(cup(id).start!(by)),
    cancel: (id: string, reason: CupCancelReason) => call<State | null>(cup(id).cancel!(reason)),
    forget: (id: string, pid: string, anon: string) => call<string>(cup(id).forget!(pid, anon)),
  };
}

export const assertCups = (env: Env) => { if (!env.CUPS) throw new AppError('NOT_FOUND', 'hosted cups are not available'); };
