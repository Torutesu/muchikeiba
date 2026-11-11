/**
 * プレイヤー主催カップ orchestration (REQ-CUP-*, contracts/protocol.md §42).
 *
 *  - CupRunner: the operations on one cup's state with the async parts (fresh race entries, the matchmaker's room start,
 *    the room's outcome, the players' close notices) behind CupPorts. The CupDO (`cup:<id>`) wraps one runner around
 *    its stored state; MemoryCupBackend wraps one per cup in a map (tests, local tools).
 *  - HostedCupsService: the HTTP entry points. The player's object is the source of truth for the limits (reserve
 *    before the cup accepts, release when it refuses), the mute lists, friends and branch; the cup's object is the
 *    source of truth for the entrants (one object, so the last slot goes to exactly one joiner).
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerInvoker } from '../http/app.js';
import type { RoomConditions } from './presets.js';
import type { HeatOutcome } from './tournaments.js';
import {
  addInvites, applyCupRaceOutcome, cancelCup, closedNoticeFor, CUP_ID_RE, cupIdFor, cupPreview, cupView, expireCup, forgetCupPlayer,
  hostedCupsConfig, isClosed, joinCup, leaveCup, makeCupCode, markRaceStarted, newCup, nextRaceSpec, normalizeCupCode, sameDefinition,
  validateCupInput, type CupCancelReason, type CupClosedNotice, type CupStartedNotice, type CupCreateInput, type CupEntrant, type CupFormat, type CupRaceSpec, type CupState,
} from './hostedCups.js';

// ------------------------------------------------------------------------------------------------ runner

export interface CupPorts<E> {
  /** Fresh race entry of an entrant at a race start. Throwing HORSE_NOT_ACTIVE / HORSE_NOT_FOUND / BANNED leaves them out of that race; other failures keep the snapshot. */
  refreshEntry(playerId: string, horseId: string): Promise<E | null>;
  /** The friend-room start for a cup race (matchmaker: every racer free, room created, assignments). Idempotent per raceId. */
  startRace(spec: CupRaceSpec<E>): Promise<{ raceId: string; startAtMs: number }>;
  raceOutcome(raceId: string): Promise<HeatOutcome | null>;
  notifyClosed(playerId: string, notice: CupClosedNotice): Promise<void>;
  /** §42.7 × §40 (Round 16 integration): the first race was assigned — each entrant but the host gets one activity entry. Best effort. */
  notifyStarted?(playerId: string, notice: CupStartedNotice): Promise<void>;
  releaseCode(code: string, cupId: string): Promise<void>;
}

/** Errors from refreshEntry that mean "may not race any more" (as in tournaments). */
const LEAVE_OUT = new Set(['HORSE_NOT_ACTIVE', 'HORSE_NOT_FOUND', 'BANNED', 'DELETION_PENDING']);
/** A start in flight blocks joins / a second start; after this long it is treated as abandoned. */
export const START_GUARD_MS = 120_000;

type Load<E> = () => CupState<E> | null;
type Save<E> = (c: CupState<E>) => void;

/** The operations on one cup (state loaded / saved through the callbacks; the caller serializes calls per cup). */
export class CupRunner<E> {
  /** In-memory only: a start whose awaits are in flight (the object's input gate lets other calls in meanwhile). */
  private startingAt = 0;
  constructor(private readonly master: () => Master, private readonly load: Load<E>, private readonly save: Save<E>, private readonly ports: CupPorts<E>, private readonly clock: () => number) {}

  private need(): CupState<E> {
    const c = this.load();
    if (!c) throw new AppError('NOT_FOUND', 'no such cup');
    return c;
  }

  create(c: CupState<E>, def: CupCreateInput): { state: CupState<E>; created: boolean } {
    const cur = this.load();
    if (cur) {
      if (!sameDefinition(cur, def, c.hostId)) throw new AppError('CONFLICT', 'this idempotency key created a different cup');
      return { state: cur, created: false };
    }
    this.save(c);
    return { state: c, created: true };
  }

  get() { return this.load(); }

  join(e: CupEntrant<E>) {
    const c = this.need();
    if (this.startingAt && this.clock() - this.startingAt < START_GUARD_MS && !c.entrants.some((x) => x.playerId === e.playerId)) throw new AppError('CUP_CLOSED', 'the cup is starting');
    const r = joinCup(c, e, this.clock());
    if (r.joined) this.save(c);
    return { ...r, state: c };
  }

  async leave(playerId: string) {
    const c = this.need();
    const r = leaveCup(c, playerId, this.clock());
    if (r.left) { this.save(c); await this.deliver(c); }
    return { ...r, state: c };
  }

  invite(by: string, ids: string[]) {
    const c = this.need();
    const added = addInvites(c, by, ids, hostedCupsConfig(this.master()).invitesPerCup, this.clock());
    if (added.length) this.save(c);
    return { added, state: c };
  }

  /** REQ-CUP-008: the host starts the next race. */
  async start(by: string) {
    const now = this.clock();
    if (this.startingAt && now - this.startingAt < START_GUARD_MS) throw new AppError('CUP_NOT_READY', 'starting');
    const c0 = this.need();
    const spec = nextRaceSpec(this.master(), c0, by, now);
    this.startingAt = now;
    try {
      // fresh entries (current horse, look); a horse that can no longer race leaves its rider out of this race
      const ids: string[] = [], entries: E[] = [];
      for (let i = 0; i < spec.playerIds.length; i++) {
        const pid = spec.playerIds[i]!;
        const ent = c0.entrants.find((x) => x.playerId === pid)!;
        try {
          const fresh = await this.ports.refreshEntry(pid, ent.horseId);
          if ((fresh as { moderation?: string } | null)?.moderation === 'banned') continue;
          ids.push(pid); entries.push(fresh ?? spec.entries[i]!);
          if (fresh) ent.entry = fresh;
        } catch (e) {
          if (!(e instanceof AppError) || !LEAVE_OUT.has(e.code)) { ids.push(pid); entries.push(spec.entries[i]!); }
        }
      }
      if (ids.length < hostedCupsConfig(this.master()).minEntrants) throw new AppError('CUP_NOT_READY', 'too_few');
      const s: CupRaceSpec<E> = { ...spec, playerIds: ids, entries };
      const started = await this.ports.startRace(s);
      const c = this.need(); // re-read: a leave / ops delete may have landed during the awaits
      if (isClosed(c)) return { raceId: started.raceId, raceIndex: spec.index, startAtMs: started.startAtMs, cancelled: true };
      for (const e of c.entrants) { const f = c0.entrants.find((x) => x.playerId === e.playerId); if (f) e.entry = f.entry; }
      markRaceStarted(c, s, started.startAtMs, this.clock());
      this.save(c);
      if (spec.index === 0 && this.ports.notifyStarted) {
        for (const pid of ids) {
          if (pid === c.hostId) continue;
          try { await this.ports.notifyStarted(pid, { cupId: c.id, cupName: c.name, raceIndex: 0 }); } catch (e) { console.error('cup start notice failed', c.id, pid, (e as Error).message); }
        }
      }
      return { raceId: started.raceId, raceIndex: spec.index, startAtMs: started.startAtMs, cancelled: false };
    } finally {
      this.startingAt = 0;
    }
  }

  async cancel(reason: CupCancelReason) {
    const c = this.load();
    if (!c) return null;
    if (cancelCup(c, reason, this.clock())) this.save(c);
    await this.deliver(c);
    return c;
  }

  async forget(playerId: string, anonName: string) {
    const c = this.load();
    if (!c) return 'none';
    const r = forgetCupPlayer(c, playerId, anonName, this.clock());
    this.save(c);
    await this.deliver(c);
    return r;
  }

  /** Alarm: poll the running race, close the window, deliver close notices. */
  async tick() {
    const c = this.load();
    if (!c) return null;
    const running = c.races.find((r) => r.status === 'running');
    if (running) {
      let o: HeatOutcome | null = null;
      try { o = await this.ports.raceOutcome(running.raceId); } catch (e) { console.error('cup race outcome failed', c.id, running.raceId, (e as Error).message); }
      const cur = this.need();
      if (applyCupRaceOutcome(this.master(), cur, running.raceId, o, this.clock())) this.save(cur);
    }
    const cur = this.need();
    if (expireCup(cur, this.clock())) this.save(cur);
    await this.deliver(cur);
    return cur;
  }

  /** Close notices to the players (kept in the outbox until delivered) and the code's release. */
  private async deliver(c: CupState<E>) {
    if (!isClosed(c) || c.outbox.length === 0) return;
    for (const pid of [...c.outbox]) {
      try {
        await this.ports.notifyClosed(pid, closedNoticeFor(c, pid));
        c.outbox = c.outbox.filter((x) => x !== pid);
      } catch (e) { console.error('cup close notice failed; will retry', c.id, pid, (e as Error).message); }
    }
    try { await this.ports.releaseCode(c.code, c.id); } catch (e) { console.error('cup code release failed', c.id, (e as Error).message); }
    this.save(c);
  }
}

// ------------------------------------------------------------------------------------------------ backend

/** What the service needs from the cups' storage (CupDO instances in production). */
export interface CupBackend<E = unknown> {
  claimCode(code: string, cupId: string): Promise<boolean>;
  releaseCode(code: string, cupId: string): Promise<void>;
  lookupCode(code: string): Promise<string | null>;
  create(state: CupState<E>, def: CupCreateInput): Promise<{ state: CupState<E>; created: boolean }>;
  get(cupId: string): Promise<CupState<E> | null>;
  join(cupId: string, e: CupEntrant<E>): Promise<{ joined: boolean; state: CupState<E> }>;
  leave(cupId: string, playerId: string): Promise<{ left: boolean; cancelled: boolean; state: CupState<E> }>;
  invite(cupId: string, by: string, ids: string[]): Promise<{ added: string[]; state: CupState<E> }>;
  start(cupId: string, by: string): Promise<{ raceId: string; raceIndex: number; startAtMs: number; cancelled: boolean }>;
  cancel(cupId: string, reason: CupCancelReason): Promise<CupState<E> | null>;
  forget(cupId: string, playerId: string, anonName: string): Promise<string>;
}

/** In-memory backend: one runner per cup, calls serialized per cup like a Durable Object's input gate. */
export class MemoryCupBackend<E = unknown> implements CupBackend<E> {
  readonly cups = new Map<string, CupState<E>>();
  readonly codes = new Map<string, string>();
  private readonly runners = new Map<string, CupRunner<E>>();
  private gates = new Map<string, Promise<unknown>>();
  constructor(private readonly master: () => Master, private readonly ports: Omit<CupPorts<E>, 'releaseCode'>, private readonly clock: () => number) {}

  runner(cupId: string): CupRunner<E> {
    let r = this.runners.get(cupId);
    if (!r) {
      r = new CupRunner<E>(this.master, () => this.cups.get(cupId) ?? null, (c) => { this.cups.set(cupId, structuredClone(c)); },
        { ...this.ports, releaseCode: async (code, id) => { if (this.codes.get(code) === id) this.codes.delete(code); } }, this.clock);
      this.runners.set(cupId, r);
    }
    return r;
  }
  private serial<T>(cupId: string, fn: () => Promise<T> | T): Promise<T> {
    const run = (this.gates.get(cupId) ?? Promise.resolve()).then(fn);
    this.gates.set(cupId, run.catch(() => undefined));
    return run;
  }
  /** Each call works on a fresh copy (like reading the object's storage): a thrown op leaves nothing behind. */
  private copy = <T>(x: T): T => structuredClone(x);

  async claimCode(code: string, cupId: string) { if (this.codes.has(code)) return false; this.codes.set(code, cupId); return true; }
  async releaseCode(code: string, cupId: string) { if (this.codes.get(code) === cupId) this.codes.delete(code); }
  async lookupCode(code: string) { return this.codes.get(code) ?? null; }
  create(state: CupState<E>, def: CupCreateInput) { return this.serial(state.id, () => this.copy(this.runner(state.id).create(state, def))); }
  async get(cupId: string) { const c = this.cups.get(cupId); return c ? this.copy(c) : null; }
  join(cupId: string, e: CupEntrant<E>) { return this.serial(cupId, () => this.copy(this.runner(cupId).join(e))); }
  leave(cupId: string, playerId: string) { return this.serial(cupId, async () => this.copy(await this.runner(cupId).leave(playerId))); }
  invite(cupId: string, by: string, ids: string[]) { return this.serial(cupId, () => this.copy(this.runner(cupId).invite(by, ids))); }
  start(cupId: string, by: string) { return this.serial(cupId, () => this.runner(cupId).start(by)); }
  cancel(cupId: string, reason: CupCancelReason) { return this.serial(cupId, async () => this.copy(await this.runner(cupId).cancel(reason))); }
  forget(cupId: string, playerId: string, anonName: string) { return this.serial(cupId, () => this.runner(cupId).forget(playerId, anonName)); }
  /** The alarm of every cup (tests advance the clock and call this). */
  async tickAll() { for (const id of [...this.cups.keys()]) await this.serial(id, () => this.runner(id).tick()); }
}

// ------------------------------------------------------------------------------------------------ service

export interface CupCreateBody {
  cupName: string; capacity: number; format: CupFormat; opensAt: number; closesAt: number;
  conditions?: RoomConditions; usePreset?: boolean; horseId: string;
}

const cupIdParam = (s: string) => { if (!CUP_ID_RE.test(s)) throw new AppError('NOT_FOUND', 'no such cup'); return s; };
const CODE_TRIES = 5;

export class HostedCupsService<E = unknown> {
  constructor(
    private readonly master: () => Master,
    private readonly backend: CupBackend<E>,
    private readonly player: (uid: string) => PlayerInvoker,
    private readonly clock: () => number = Date.now,
    /** REQ-CUP-004: the members of a branch (TeamDO view); absent = branch invitations invite nobody. */
    private readonly teamMembers?: (teamId: string, viewer: string) => Promise<string[]>,
  ) {}

  private cfg() { return hostedCupsConfig(this.master()); }
  private enabled() { if (!this.cfg().enabled) throw new AppError('NOT_FOUND', 'hosted cups are not available'); }

  /** REQ-CUP-007: GET /v1/cups — the player's list (limits, active cups with their views, invitations, history). */
  async list(uid: string) {
    const mine = await this.player(uid).invoke('cupsMine', uid);
    const now = this.clock();
    const active = [];
    for (const r of mine.active) {
      const c = await this.backend.get(r.cupId).catch(() => null);
      if (c && !isClosed(c) && c.entrants.some((e) => e.playerId === uid)) active.push(cupView(this.master(), c, uid, now));
    }
    return { ...mine, active };
  }

  /** The entry of the player's own horse (REQ-CUP-005: nobody picks a horse for someone else). */
  private async entrantOf(uid: string, horseId: string, via: CupEntrant<E>['via'], who: { displayName: string; blocks: string[] }): Promise<CupEntrant<E>> {
    const entry = await this.player(uid).invoke('raceEntry', uid, horseId) as unknown as E & { moderation?: string; visual?: { displayName?: string } };
    if (entry.moderation === 'banned') throw new AppError('BANNED');
    const horses = await this.player(uid).invoke('cupHorseName', uid, horseId);
    return { playerId: uid, displayName: who.displayName, horseId, horseName: horses, joinedAt: 0, via, withdrawn: false, blocks: who.blocks, entry };
  }

  /** REQ-CUP-001: create (idempotent per key: the cup id is derived from host + key). */
  async create(uid: string, b: CupCreateBody, idemKey: string) {
    this.enabled();
    const now = this.clock();
    let conditions = b.conditions;
    if (b.usePreset) {
      const p = await this.player(uid).invoke('presets', uid);
      if (!p.room) throw new AppError('BAD_REQUEST', 'no saved room conditions');
      conditions = p.room;
    }
    if (!conditions) throw new AppError('BAD_REQUEST', 'send conditions or usePreset');
    const def = validateCupInput(this.master(), { cupName: b.cupName, capacity: b.capacity, format: b.format, opensAt: b.opensAt, closesAt: b.closesAt, conditions }, now);
    const cupId = await cupIdFor(uid, idemKey);
    const existing = await this.backend.get(cupId);
    if (existing) {
      if (!sameDefinition(existing, def, uid)) throw new AppError('CONFLICT', 'this idempotency key created a different cup');
      return { cup: cupView(this.master(), existing, uid, now), created: false };
    }
    const p = this.player(uid);
    const who = await p.invoke('cupReserve', uid, cupId, 'host', def.closesAt, b.horseId);
    let code: string | null = null;
    try {
      const host = await this.entrantOf(uid, b.horseId, 'host', who);
      for (let i = 0; i < CODE_TRIES && !code; i++) { const c = makeCupCode(); if (await this.backend.claimCode(c, cupId)) code = c; }
      if (!code) throw new Error('cup code space exhausted');
      const out = await this.backend.create(newCup(cupId, code, def, { ...host, joinedAt: now }, who.teamId, now), def);
      if (out.state.code !== code) { await this.backend.releaseCode(code, cupId).catch(() => undefined); code = null; } // a concurrent retry made the cup
      await p.invoke('cupCommitted', uid, cupId, 'create', { format: def.format, capacity: def.capacity, team: !!who.teamId, cupName: def.cupName });
      return { cup: cupView(this.master(), out.state, uid, now), created: out.created };
    } catch (e) {
      if (code) await this.backend.releaseCode(code, cupId).catch(() => undefined);
      await p.invoke('cupRelease', uid, cupId).catch(() => undefined);
      throw e;
    }
  }

  private async visible(uid: string, cupId: string) {
    const c = await this.backend.get(cupIdParam(cupId));
    if (!c || (c.hostId !== uid && !c.entrants.some((e) => e.playerId === uid) && !c.invited.includes(uid))) throw new AppError('NOT_FOUND', 'no such cup');
    return c;
  }

  async get(uid: string, cupId: string) {
    return cupView(this.master(), await this.visible(uid, cupId), uid, this.clock());
  }

  /** REQ-CUP-003: a code → its cup (counts an attempt whatever the answer). */
  private async byCode(uid: string, raw: string) {
    this.enabled();
    await this.player(uid).invoke('cupCodeAttempt', uid);
    const code = normalizeCupCode(raw);
    const cupId = code ? await this.backend.lookupCode(code) : null;
    const c = cupId ? await this.backend.get(cupId) : null;
    if (!c || isClosed(c) || c.code !== code) throw new AppError('CUP_CODE_INVALID');
    return c;
  }

  /**
   * REQ-CUP-006: muted either way (the current lists of everyone in the cup, at most capacity reads). The cup's own
   * check on the snapshots stays as the atomic guard for two joiners who mute each other and join at the same time.
   */
  private async blocked(c: CupState<E>, uid: string): Promise<boolean> {
    const mine = new Set((await this.player(uid).invoke('feedMutes', uid)).muted);
    for (const e of c.entrants) {
      if (e.playerId === uid) continue;
      if (mine.has(e.playerId) || e.blocks.includes(uid)) return true;
      const theirs = await this.player(e.playerId).invoke('feedMutes', e.playerId).catch(() => ({ muted: [] as string[] }));
      if (theirs.muted.includes(uid)) return true;
    }
    return false;
  }

  async lookup(uid: string, raw: string) {
    const c = await this.byCode(uid, raw);
    if (await this.blocked(c, uid)) throw new AppError('CUP_CODE_INVALID');
    return { ...cupPreview(c), role: c.entrants.some((e) => e.playerId === uid) ? 'entrant' : 'none' };
  }

  /** REQ-CUP-005/006: join by code or by invitation (idempotent per player). */
  async join(uid: string, b: { code?: string; cupId?: string; horseId: string }, idemKey: string) {
    this.enabled();
    if ((b.code === undefined) === (b.cupId === undefined)) throw new AppError('BAD_REQUEST', 'send a code or a cupId');
    const c = b.code !== undefined ? await this.byCode(uid, b.code) : await this.visible(uid, b.cupId!);
    const via: CupEntrant<E>['via'] = b.code !== undefined ? 'code' : 'invite';
    const now = this.clock();
    if (c.entrants.some((e) => e.playerId === uid)) return { cup: cupView(this.master(), c, uid, now), joined: false };
    if (await this.blocked(c, uid)) throw new AppError('CUP_CODE_INVALID');
    const p = this.player(uid);
    const who = await p.invoke('cupReserve', uid, c.id, 'entrant', c.closesAt, b.horseId);
    try {
      const e = await this.entrantOf(uid, b.horseId, via, who);
      const out = await this.backend.join(c.id, e);
      if (out.joined) await p.invoke('cupCommitted', uid, c.id, 'join', { format: c.format, via, cupName: c.name });
      else if (!who.already) await p.invoke('cupRelease', uid, c.id);
      void idemKey;
      return { cup: cupView(this.master(), out.state, uid, this.clock()), joined: out.joined };
    } catch (e) {
      if (!who.already) await p.invoke('cupRelease', uid, c.id).catch(() => undefined);
      throw e;
    }
  }

  /** REQ-CUP-011 (idempotent: not in it → left: false). */
  async leave(uid: string, cupId: string) {
    const c = await this.backend.get(cupIdParam(cupId));
    if (!c || !c.entrants.some((e) => e.playerId === uid)) return { left: false, cancelled: false, cup: null };
    const out = await this.backend.leave(c.id, uid);
    // a player who left before the first race is no longer in it: free the slot on their side too
    if (out.left && !out.state.entrants.some((e) => e.playerId === uid)) await this.player(uid).invoke('cupLeft', uid, c.id);
    return { left: out.left, cancelled: out.cancelled, cup: out.state.entrants.some((e) => e.playerId === uid) ? cupView(this.master(), out.state, uid, this.clock()) : null };
  }

  /** REQ-CUP-004: friends (mutual) or the host's branch; blocked pairs and others are skipped silently. */
  async invite(uid: string, cupId: string, b: { friendIds?: string[]; team?: boolean }) {
    const c = await this.backend.get(cupIdParam(cupId));
    if (!c || c.hostId !== uid) throw new AppError(c && c.entrants.some((e) => e.playerId === uid) ? 'NOT_HOST' : 'NOT_FOUND');
    const friendIds = new Set((await this.player(uid).invoke('friendsState', uid)).ids);
    const mutes = new Set((await this.player(uid).invoke('feedMutes', uid)).muted);
    const requested = new Set(b.friendIds ?? []);
    let candidates: string[] = [...requested].filter((id) => friendIds.has(id));
    if (b.team) {
      const teamId = (await this.player(uid).invoke('cupsMine', uid)).teamId;
      const members = teamId && this.teamMembers ? await this.teamMembers(teamId, uid) : [];
      for (const m of members) requested.add(m);
      candidates = [...candidates, ...members];
    }
    requested.delete(uid);
    const wanted = [...new Set(candidates)].filter((id) => id !== uid && !mutes.has(id));
    const out = await this.backend.invite(c.id, uid, wanted);
    let invited = 0;
    const hostName = c.entrants.find((e) => e.playerId === uid)?.displayName ?? '';
    for (const id of out.added) {
      const ok = await this.player(id).invoke('cupInvited', id, { cupId: c.id, cupName: c.name, hostId: uid, hostName, at: this.clock(), until: c.closesAt }).catch(() => false);
      if (ok) invited++;
    }
    return { invited, skipped: Math.max(0, requested.size - invited) };
  }

  /** REQ-CUP-008. */
  async start(uid: string, cupId: string) {
    const c = await this.backend.get(cupIdParam(cupId));
    if (!c || !c.entrants.some((e) => e.playerId === uid)) throw new AppError('NOT_FOUND', 'no such cup');
    const r = await this.backend.start(c.id, uid);
    return { raceId: r.raceId, raceIndex: r.raceIndex, startAtMs: r.startAtMs };
  }

  /** REQ-CUP-015: ops delete. */
  async adminDelete(cupId: string) {
    const c = await this.backend.cancel(cupIdParam(cupId), 'ops_deleted');
    if (!c) throw new AppError('NOT_FOUND', 'no such cup');
    return { cupId: c.id, status: c.status, cancelReason: c.cancelReason };
  }

  async adminView(cupId: string) {
    const c = await this.backend.get(cupIdParam(cupId));
    if (!c) throw new AppError('NOT_FOUND', 'no such cup');
    return { ...cupView(this.master(), c, '', this.clock()), invited: c.invited.length, hostId: c.hostId, createdAt: c.createdAt };
  }
}
