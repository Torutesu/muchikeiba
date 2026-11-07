/**
 * ライバル orchestration (REQ-RIVAL-*, contracts/protocol.md §28): the week registry and the cross-player steps.
 *
 * The registry is one object per game week (`rival:<weekId>`; production: a LeaderboardDO instance with its own rv_*
 * tables, do/rivalStore.ts; tests: MemoryRivalRegistry). It holds, for its week W:
 *   entries    candidates registered during W (players who raced ranked in W) — read once by W+1's pairing;
 *   pairs      W's assignments, computed on first use from W−1's entries (pairWeek, deterministic), CPU rivals for
 *              late joiners, and the instant a pair was dissolved;
 *   withdrawn  players who opted out / were banned / are being deleted during W (never paired, card hidden);
 *   ta         both sides' best time-attack time per course in W, and which "your rival beat you" pushes went out.
 * The registry never touches a player object; the service below does, in a fixed order, and every step is idempotent.
 * The player object keeps its own tallies (rival.ts), so a registry outage only delays what the rival screen shows.
 */
import type { Master } from './master.js';
import { AppError } from './errors.js';
import {
  cpuRivalFor, pairWeek, prevWeekId, rivalConfig, rivalTrackName, type RegistryWeek, type RivalAssign, type RivalCard, type RivalEntry, type RivalUpdate,
} from './rival.js';
import type { PlayerInvoker } from '../http/app.js';

// ------------------------------------------------------------------------------------------------ registry

export interface PairRow { kind: 'human' | 'cpu'; rivalId: string | null; cpuId: string | null; dissolvedAt: number | null }

/** Storage of one week (SQL tables in the Durable Object, maps in memory). Synchronous like Durable Object SQLite. */
export interface RivalWeekStore {
  paired(): boolean; setPaired(at: number): void;
  entry(pid: string): RivalEntry | null; putEntry(e: RivalEntry): void; deleteEntry(pid: string): void;
  /** Candidates in player-id order after `after` (paging for the next week's pairing). */
  entriesAfter(after: string, limit: number): RivalEntry[];
  pair(pid: string): PairRow | null; putPair(pid: string, row: PairRow): void;
  /** The public card a paired player had registered last week (shown until they register again this week). */
  card(pid: string): RivalCard | null; putCard(pid: string, c: RivalCard): void; deleteCard(pid: string): void;
  isWithdrawn(pid: string): boolean; setWithdrawn(pid: string, on: boolean): void; withdrawnAll(): string[];
  ta(pid: string): Record<string, number>; putTa(pid: string, trackId: string, ms: number): void; deleteTa(pid: string): void;
  notified(k: string): boolean; addNotified(k: string): void;
}

const PAGE = 500;

/** The registry logic of one week, over any store. `prevEntries` pages through the previous week's candidates. */
export class RivalWeekCore {
  constructor(private readonly st: RivalWeekStore, private readonly weekId: string, private readonly master: Master,
    private readonly prevEntries: (after: string, limit: number) => Promise<RivalEntry[]>) {}

  /** REQ-RIVAL-003: pair once (on the first call of the week; the cron also calls it). Idempotent. */
  async ensurePaired(now: number): Promise<{ pairs: number; candidates: number }> {
    if (this.st.paired()) return { pairs: 0, candidates: 0 };
    const c = rivalConfig(this.master);
    const all: RivalEntry[] = [];
    let after = '';
    for (;;) {
      const page = await this.prevEntries(after, PAGE);
      all.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1]!.playerId;
    }
    if (this.st.paired()) return { pairs: 0, candidates: 0 }; // paired by an overlapping call while we read
    let n = 0;
    if (c) {
      const pairs = pairWeek(c, this.weekId, all, new Set(this.st.withdrawnAll()));
      for (const [a, b] of pairs) {
        if (this.st.pair(a)) continue;
        this.st.putPair(a, { kind: 'human', rivalId: b, cpuId: null, dissolvedAt: null });
        n++;
      }
      // cards of last week's registrations: kept for the pair's view until the rival registers again this week
      for (const e of all) if (pairs.has(e.playerId)) this.st.putCard(e.playerId, e.card);
    }
    this.st.setPaired(now);
    return { pairs: n / 2, candidates: all.length };
  }

  /** My assignment (a late joiner gets a CPU rival, stored so it stays the same all week). */
  async assignment(pid: string, now: number): Promise<RegistryWeek> {
    await this.ensurePaired(now);
    const c = rivalConfig(this.master);
    if (!c) throw new AppError('NOT_FOUND', 'rivals are not available');
    let p = this.st.pair(pid);
    if (!p) {
      p = { kind: 'cpu', rivalId: null, cpuId: cpuRivalFor(c, this.weekId, pid).id, dissolvedAt: null };
      this.st.putPair(pid, p);
    }
    let assignment: RivalAssign;
    let rivalTa: Record<string, number> = {};
    if (p.kind === 'human') {
      const r = p.rivalId!;
      const gone = this.st.isWithdrawn(r) || this.st.isWithdrawn(pid);
      const card = gone ? null : (this.st.entry(r)?.card ?? this.st.card(r));
      assignment = { kind: 'human', rivalId: r, card, dissolvedAt: p.dissolvedAt };
      if (p.dissolvedAt === null) rivalTa = this.st.ta(r);
    } else assignment = { kind: 'cpu', cpuId: p.cpuId! };
    return { weekId: this.weekId, assignment, ta: { me: this.st.ta(pid), rival: rivalTa } };
  }

  private dissolvePair(pid: string, now: number) {
    const p = this.st.pair(pid);
    if (p?.kind !== 'human' || p.dissolvedAt !== null) return;
    this.st.putPair(pid, { ...p, dissolvedAt: now });
    const o = this.st.pair(p.rivalId!);
    if (o?.kind === 'human' && o.rivalId === pid && o.dissolvedAt === null) this.st.putPair(p.rivalId!, { ...o, dissolvedAt: now });
  }

  /** REQ-RIVAL-002: candidate for next week (latest wins); a block of this week's rival dissolves the pair. */
  register(e: RivalEntry, now: number) {
    const cur = this.st.entry(e.playerId);
    if (cur && cur.updatedAt > e.updatedAt) return;
    this.st.setWithdrawn(e.playerId, false);
    this.st.putEntry(e);
    const p = this.st.pair(e.playerId);
    if (p?.kind === 'human' && e.blocked.includes(p.rivalId!)) this.dissolvePair(e.playerId, now);
  }

  /** REQ-RIVAL-011: opted out / banned / deletion scheduled — no candidate entry, this week's pair dissolved, card hidden. */
  withdraw(pid: string, now: number) {
    this.st.deleteEntry(pid);
    this.st.deleteCard(pid);
    this.st.setWithdrawn(pid, true);
    this.dissolvePair(pid, now);
  }

  dissolve(pid: string, now: number) { this.dissolvePair(pid, now); }

  /** REQ-UXS-040: the account deletion — everything about the player in this week. */
  forget(pid: string, now: number) {
    this.withdraw(pid, now);
    this.st.deleteTa(pid);
  }

  /**
   * REQ-RIVAL-005/013: a new weekly best. Returns the rival to notify when this run took the course from them (their
   * week best was ahead of mine and now is not), once per pair, course and week.
   */
  taBest(pid: string, trackId: string, ms: number): { notify: string | null } {
    const prev = this.st.ta(pid)[trackId];
    if (prev !== undefined && prev <= ms) return { notify: null };
    this.st.putTa(pid, trackId, ms);
    const p = this.st.pair(pid);
    if (p?.kind !== 'human' || p.dissolvedAt !== null || this.st.isWithdrawn(pid) || this.st.isWithdrawn(p.rivalId!)) return { notify: null };
    const theirs = this.st.ta(p.rivalId!)[trackId];
    if (theirs === undefined || ms >= theirs || (prev !== undefined && prev < theirs)) return { notify: null };
    const k = `${pid}>${p.rivalId}:${trackId}`;
    if (this.st.notified(k)) return { notify: null };
    this.st.addNotified(k);
    return { notify: p.rivalId };
  }
}

/** The registry as the service sees it (one call = one week object). */
export interface RivalRegistry {
  ensurePaired(weekId: string): Promise<unknown>;
  assignment(weekId: string, playerId: string): Promise<RegistryWeek>;
  register(weekId: string, e: RivalEntry): Promise<void>;
  withdraw(weekId: string, playerId: string): Promise<void>;
  dissolve(weekId: string, playerId: string): Promise<void>;
  taBest(weekId: string, playerId: string, trackId: string, timeMs: number): Promise<{ notify: string | null }>;
  forget(weekId: string, playerId: string): Promise<void>;
}

export class MemoryWeekStore implements RivalWeekStore {
  private p = false;
  readonly entries = new Map<string, RivalEntry>();
  readonly pairs = new Map<string, PairRow>();
  readonly withdrawnSet = new Set<string>();
  readonly tas = new Map<string, Record<string, number>>();
  readonly sent = new Set<string>();
  readonly cards = new Map<string, RivalCard>();
  card(pid: string) { const c = this.cards.get(pid); return c ? structuredClone(c) : null; }
  putCard(pid: string, c: RivalCard) { this.cards.set(pid, structuredClone(c)); }
  deleteCard(pid: string) { this.cards.delete(pid); }
  paired() { return this.p; }
  setPaired() { this.p = true; }
  entry(pid: string) { const e = this.entries.get(pid); return e ? structuredClone(e) : null; }
  putEntry(e: RivalEntry) { this.entries.set(e.playerId, structuredClone(e)); }
  deleteEntry(pid: string) { this.entries.delete(pid); }
  entriesAfter(after: string, limit: number) {
    return [...this.entries.values()].filter((e) => e.playerId > after).sort((a, b) => (a.playerId < b.playerId ? -1 : 1)).slice(0, limit).map((e) => structuredClone(e));
  }
  pair(pid: string) { const r = this.pairs.get(pid); return r ? { ...r } : null; }
  putPair(pid: string, row: PairRow) { this.pairs.set(pid, { ...row }); }
  isWithdrawn(pid: string) { return this.withdrawnSet.has(pid); }
  setWithdrawn(pid: string, on: boolean) { if (on) this.withdrawnSet.add(pid); else this.withdrawnSet.delete(pid); }
  withdrawnAll() { return [...this.withdrawnSet]; }
  ta(pid: string) { return { ...(this.tas.get(pid) ?? {}) }; }
  putTa(pid: string, trackId: string, ms: number) { this.tas.set(pid, { ...(this.tas.get(pid) ?? {}), [trackId]: ms }); }
  deleteTa(pid: string) { this.tas.delete(pid); }
  notified(k: string) { return this.sent.has(k); }
  addNotified(k: string) { this.sent.add(k); }
}

/** In-memory registry (tests, local tools). */
export class MemoryRivalRegistry implements RivalRegistry {
  readonly weeks = new Map<string, MemoryWeekStore>();
  constructor(private readonly master: () => Master, private readonly clock: () => number = Date.now) {}
  store(weekId: string) {
    let s = this.weeks.get(weekId);
    if (!s) this.weeks.set(weekId, (s = new MemoryWeekStore()));
    return s;
  }
  private core(weekId: string) {
    return new RivalWeekCore(this.store(weekId), weekId, this.master(), async (after, limit) => this.store(prevWeekId(weekId)).entriesAfter(after, limit));
  }
  async ensurePaired(weekId: string) { return this.core(weekId).ensurePaired(this.clock()); }
  async assignment(weekId: string, pid: string) { return this.core(weekId).assignment(pid, this.clock()); }
  async register(weekId: string, e: RivalEntry) { this.core(weekId).register(e, this.clock()); }
  async withdraw(weekId: string, pid: string) { this.core(weekId).withdraw(pid, this.clock()); }
  async dissolve(weekId: string, pid: string) { this.core(weekId).dissolve(pid, this.clock()); }
  async taBest(weekId: string, pid: string, trackId: string, ms: number) { return this.core(weekId).taBest(pid, trackId, ms); }
  async forget(weekId: string, pid: string) { this.core(weekId).forget(pid, this.clock()); }
}

// ------------------------------------------------------------------------------------------------ service

type Svc = import('./service.js').PlayerService;
type Ret<K extends keyof Svc> = Awaited<ReturnType<Svc[K] extends (...a: never[]) => unknown ? Svc[K] : never>>;

/** Player steps the orchestration needs (Durable Object RPC in production, PlayerService in tests). */
export interface RivalPlayers {
  peek(uid: string): Promise<Ret<'rivalPeek'>>;
  sync(uid: string, data: Record<string, RegistryWeek | null>): Promise<Ret<'rivalSync'>>;
  setOptOut(uid: string, optOut: boolean): Promise<Ret<'rivalSetOptOut'>>;
  block(uid: string): Promise<Ret<'rivalBlock'>>;
  challengeCheck(uid: string): Promise<Ret<'rivalChallengeCheck'>>;
  challengeReceive(uid: string, fromId: string, passphrase: string, fromName: string): Promise<unknown>;
  seen(uid: string, weekId: string): Promise<unknown>;
  push(uid: string, byName: string, course: string): Promise<unknown>;
}

export function rivalPlayersFrom(player: (uid: string) => PlayerInvoker): RivalPlayers {
  return {
    peek: (u) => player(u).invoke('rivalPeek', u),
    sync: (u, d) => player(u).invoke('rivalSync', u, d),
    setOptOut: (u, o) => player(u).invoke('rivalSetOptOut', u, o),
    block: (u) => player(u).invoke('rivalBlock', u),
    challengeCheck: (u) => player(u).invoke('rivalChallengeCheck', u),
    challengeReceive: (u, f, p, n) => player(u).invoke('rivalChallengeReceive', u, f, p, n),
    seen: (u, w) => player(u).invoke('rivalSeen', u, w),
    push: (u, n, c) => player(u).invoke('rivalPush', u, n, c),
  };
}

export class RivalService {
  constructor(private readonly master: () => Master, private readonly players: RivalPlayers, private readonly reg: RivalRegistry) {}

  private enabled() {
    if (!rivalConfig(this.master())) throw new AppError('NOT_FOUND', 'rivals are not available');
  }

  /**
   * REQ-RIVAL-009: GET /v1/rival. Asks the registry about every unsettled week (a failing registry leaves that week as the
   * player last saw it), re-sends what the registry should already know (a pair I dissolved, my weekly bests), then
   * lets the player object apply the answers and settle ended weeks.
   */
  async view(uid: string) {
    if (!rivalConfig(this.master())) return { enabled: false as const };
    const p = await this.players.peek(uid);
    const data: Record<string, RegistryWeek | null> = {};
    if (p.withdrawn) {
      await this.reg.withdraw(p.currentWeek, uid).catch((e) => console.error('rival withdraw failed', uid, (e as Error).message));
    } else {
      for (const w of p.weeks) {
        try {
          let d = await this.reg.assignment(w, uid);
          if (w === p.currentWeek) {
            if (p.dissolveMine && d.assignment.kind === 'human' && d.assignment.dissolvedAt === null) { await this.reg.dissolve(w, uid); d = await this.reg.assignment(w, uid); }
            for (const [t, ms] of Object.entries(p.ta)) if (d.ta.me[t] === undefined || d.ta.me[t]! > ms) await this.reg.taBest(w, uid, t, ms);
          }
          data[w] = d;
        } catch (e) {
          console.error('rival registry unavailable', uid, w, (e as Error).message);
          data[w] = null;
        }
      }
    }
    return this.players.sync(uid, data);
  }

  async setOptOut(uid: string, optOut: boolean) {
    this.enabled();
    const r = await this.players.setOptOut(uid, optOut);
    if (optOut) await this.reg.withdraw(r.view.weekId as string, uid).catch(() => undefined); // the hook sends it too
    return { optOut: r.optOut };
  }

  /** REQ-RIVAL-011: block this week's rival (shared block list) and dissolve the pair for both. */
  async block(uid: string) {
    this.enabled();
    const r = await this.players.block(uid);
    const p = await this.players.peek(uid);
    await this.reg.dissolve(p.currentWeek, uid);
    return r;
  }

  /** REQ-RIVAL-008: ライバルと走る — invite this week's rival to my friend room (membership checked by the route). */
  async challenge(uid: string, passphrase: string) {
    this.enabled();
    const me = await this.players.peek(uid);
    const d = await this.reg.assignment(me.currentWeek, uid);
    if (d.assignment.kind !== 'human' || d.assignment.dissolvedAt !== null) throw new AppError('NOT_ELIGIBLE', 'no human rival to challenge this week');
    const c = await this.players.challengeCheck(uid);
    if (c.rivalId !== d.assignment.rivalId) throw new AppError('NOT_ELIGIBLE', 'open the rival screen first');
    await this.view(c.rivalId); // the rival may not have opened the rival screen this week: sync it first
    await this.players.challengeReceive(c.rivalId, uid, passphrase, c.displayName);
    return { ok: true, rivalId: c.rivalId };
  }

  async seen(uid: string, weekId: string) { this.enabled(); return this.players.seen(uid, weekId); }

  /** The player object's post-transaction hook (best effort). */
  async apply(u: RivalUpdate) {
    if (u.withdraw) await this.reg.withdraw(u.weekId, u.playerId);
    if (u.entry) await this.reg.register(u.weekId, u.entry);
    if (u.dissolve) await this.reg.dissolve(u.weekId, u.playerId);
    for (const t of u.ta ?? []) {
      const r = await this.reg.taBest(u.weekId, u.playerId, t.trackId, t.timeMs);
      if (r.notify) await this.players.push(r.notify, u.displayName ?? '', rivalTrackName(t.trackId)).catch((e) => console.error('rival push failed', r.notify, (e as Error).message));
    }
  }
}
