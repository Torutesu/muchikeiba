import type { Rng } from './rng.js';
import type { ClientMessage, InputTriple, RaceStartConfig, ReplayLog, ServerMessage, VerifierOutput } from './schemas.js';

/** Input bits (contracts/protocol.md §3). */
export const CMD = { START: 1, LANE_IN: 2, LANE_OUT: 4, REIN_PRESS: 8, REIN_RELEASE: 16, WHIP: 32, CPU_TAKEOVER: 64, HUMAN_RESUME: 128 } as const;
const CLIENT_MASK = 0x3f;

export interface RoomOptions {
  /** Probability (0..1) that an otherwise-confirmed race is re-simulated anyway (REQ-NET-008). */
  verifySampleRate: number;
  /**
   * How long to wait for the remaining results once a majority of connected humans has reported
   * (or after the room hit maxTicks).
   */
  resultWaitMs: number;
  rng: Rng;
}
export const DEFAULT_ROOM_OPTIONS = { verifySampleRate: 0.05, resultWaitMs: 5000 };

export type Outbound = { to: number | 'all'; msg: ServerMessage };
export type RoomPhase = 'running' | 'awaitingResults' | 'verifying' | 'final';

interface ReportedResult { h: string; order: number[]; finishTicks?: number[] }
interface Conn {
  connected: boolean; disconnectedAt: number | null; cpu: boolean; everConnected: boolean;
  /** Last message time (REQ-NET-013: a silent socket counts as disconnected after disconnectGraceMs). */
  lastMsgAt?: number;
}

export interface FinalOutcome {
  status: 'confirmed' | 'void';
  order: number[];
  hash: string;
  via: 'consensus' | 'verifier' | 'none';
  /** Human slots whose reported hash disagreed with the final result (cheat/desync suspects). */
  suspects: number[];
  /** Finish ticks in `order` (verifier output, or identical reports of all agreeing clients). Optional. */
  finishTicks?: number[];
}

export interface RoomSnapshot {
  config: RaceStartConfig; startAtMs: number; opts: Omit<RoomOptions, 'rng'>;
  conns: [number, Conn][]; pending: [number, [number, number][]][]; log: InputTriple[];
  confirmedTick: number; lastBundledTick: number; phase: RoomPhase; stoppedAtMs: number | null;
  /** When a majority of connected humans had reported (absent in snapshots from older builds). */
  majorityAtMs?: number | null;
  checksums: [number, [number, string][]][]; desync: number[]; results: [number, ReportedResult][];
  reported: boolean; final: FinalOutcome | null;
}

/**
 * Lockstep relay for one race (REQ-NET-*). Pure: no I/O, time is passed in. The Durable Object
 * only forwards socket events here and sends back the returned messages.
 */
export class RaceRoomCore {
  private conns = new Map<number, Conn>();
  private pending = new Map<number, Map<number, number>>();
  private log: InputTriple[] = [];
  private confirmedTick = -1;
  private lastBundledTick = -1;
  private _phase: RoomPhase = 'running';
  private stoppedAtMs: number | null = null;
  private majorityAtMs: number | null = null;
  private checksums = new Map<number, Map<number, string>>();
  private desync = new Set<number>();
  private results = new Map<number, ReportedResult>();
  private reported = false;
  private _final: FinalOutcome | null = null;
  readonly humanSlots: number[];
  /** Earliest tick on which any horse could possibly finish; results before it are rejected (REQ-NET-012). */
  readonly minResultTick: number;

  constructor(readonly config: RaceStartConfig, readonly startAtMs: number, private readonly opts: RoomOptions) {
    this.humanSlots = config.entrants.filter((e) => e.kind === 'human').map((e) => e.slot);
    for (const s of this.humanSlots) this.conns.set(s, { connected: false, disconnectedAt: null, cpu: false, everConnected: false });
    this.minResultTick = minPlausibleFinishTick(config);
  }

  get phase() { return this._phase; }
  get final() { return this._final; }
  get lastConfirmedTick() { return this.confirmedTick; }
  get desyncSlots() { return [...this.desync].sort((a, b) => a - b); }
  get maxTicks() { return this.config.ruleset.maxTicks as number; }
  isCpuControlled(slot: number) { return this.conns.get(slot)?.cpu ?? false; }

  slotOf(playerId: string): number | null {
    const e = this.config.entrants.find((x) => x.playerId === playerId);
    return e ? e.slot : null;
  }

  /** Tick n is confirmed once now >= startAt + (n+1) * 1000 / tickHz. */
  private dueTick(now: number): number {
    return Math.floor(((now - this.startAtMs) * this.config.net.tickHz) / 1000) - 1;
  }

  private addCmd(tick: number, slot: number, cmd: number) {
    let m = this.pending.get(tick);
    if (!m) this.pending.set(tick, (m = new Map()));
    m.set(slot, (m.get(slot) ?? 0) | cmd);
  }

  private bundle(from: number, to: number): ServerMessage {
    return { t: 'b', from, to, in: this.log.filter(([t]) => t >= from && t <= to) };
  }

  hello(slot: number, lastTick: number, now: number): Outbound[] {
    const c = this.conns.get(slot);
    if (!c) return [{ to: slot, msg: { t: 'err', code: 'NOT_IN_RACE' } }];
    const out: Outbound[] = [{ to: slot, msg: { t: 'start', you: slot, startAtMs: this.startAtMs, config: this.config } }];
    this.markAlive(c, slot, now);
    const from = Math.max(0, lastTick + 1);
    if (this.confirmedTick >= from) out.push({ to: slot, msg: this.bundle(from, this.confirmedTick) });
    if (this._final) out.push({ to: slot, msg: this.finalMsg() });
    return out;
  }

  disconnect(slot: number, now: number) {
    const c = this.conns.get(slot);
    if (c && c.connected) {
      c.connected = false;
      c.disconnectedAt = now;
    }
  }

  private isAdvancing() { return this._phase === 'running'; }

  private markAlive(c: Conn, slot: number, now: number) {
    c.connected = true;
    c.disconnectedAt = null;
    c.everConnected = true;
    c.lastMsgAt = now;
    if (c.cpu && this.isAdvancing()) {
      // REQ-NET-007: hand control back at the next unconfirmed tick
      this.addCmd(this.confirmedTick + 1, slot, CMD.HUMAN_RESUME);
      c.cpu = false;
    }
  }

  message(slot: number, msg: ClientMessage, now: number): Outbound[] {
    const c = this.conns.get(slot);
    if (!c) return [{ to: slot, msg: { t: 'err', code: 'NOT_IN_RACE' } }];
    if (msg.t !== 'hello') {
      if (c.connected) c.lastMsgAt = now;
      else if (c.everConnected) this.markAlive(c, slot, now); // a client we had written off is talking again
    }
    switch (msg.t) {
      case 'hello':
        return this.hello(slot, msg.lastTick, now);
      case 'ping':
        return [{ to: slot, msg: { t: 'pong', c: msg.c, s: now } }];
      case 'in': {
        if (!this.isAdvancing()) return [{ to: slot, msg: { t: 'err', code: 'RACE_OVER' } }];
        const cmd = msg.cmd & CLIENT_MASK;
        const maxAhead = Math.max(1, this.config.net.inputDelayTicks * 4);
        if (msg.tick > this.confirmedTick + maxAhead) return [{ to: slot, msg: { t: 'err', code: 'TOO_EARLY' } }];
        if (cmd === 0) return [];
        const tick = Math.max(msg.tick, this.confirmedTick + 1); // REQ-NET-002 late-input shift
        if (tick > this.maxTicks - 1) return [{ to: slot, msg: { t: 'err', code: 'RACE_OVER' } }];
        this.addCmd(tick, slot, cmd);
        return [];
      }
      case 'chk':
        return this.onChecksum(slot, msg.tick, msg.h);
      case 'res':
        if (this._phase !== 'running' && this._phase !== 'awaitingResults') return [{ to: slot, msg: { t: 'err', code: 'RACE_OVER' } }];
        if (this.results.has(slot)) return []; // first report counts; a client cannot swap its hash later
        if (this.confirmedTick < this.minResultTick) return [{ to: slot, msg: { t: 'err', code: 'RESULT_TOO_EARLY' } }];
        this.results.set(slot, msg.finishTicks ? { h: msg.h, order: msg.order, finishTicks: msg.finishTicks } : { h: msg.h, order: msg.order });
        return this.checkResults(now);
    }
  }

  private onChecksum(slot: number, tick: number, h: string): Outbound[] {
    if (tick % this.config.net.checksumIntervalTicks !== 0 || tick > this.confirmedTick) return [{ to: slot, msg: { t: 'err', code: 'BAD_MESSAGE' } }];
    let m = this.checksums.get(tick);
    if (!m) this.checksums.set(tick, (m = new Map()));
    m.set(slot, h);
    const connected = this.humanSlots.filter((s) => this.conns.get(s)!.connected);
    if (m.size < 2 || !connected.every((s) => m.has(s))) return [];
    const counts = new Map<string, number>();
    for (const v of m.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
    const [majority, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    this.checksums.delete(tick);
    if (n * 2 <= m.size) return []; // no strict majority: leave it to the final result check
    const out: Outbound[] = [];
    for (const [s, v] of m) {
      if (v !== majority) {
        this.desync.add(s);
        out.push({ to: s, msg: { t: 'desync', tick } });
      }
    }
    return out;
  }

  private connectedHumans() { return this.humanSlots.filter((s) => this.conns.get(s)!.connected); }

  /**
   * REQ-NET-008 / REQ-NET-012: a single `res` never stops the room (one client finishing early — or
   * lying — must not freeze honest clients mid-race; ticks past a client's end are harmless). The room
   * stops and decides when every connected human has reported, or when a strict majority of connected
   * humans has reported and `resultWaitMs` has passed since then, or (in advance()) at maxTicks.
   */
  private checkResults(now: number): Outbound[] {
    const connected = this.connectedHumans();
    const reported = connected.filter((s) => this.results.has(s)).length;
    const out: Outbound[] = [];
    if (connected.length > 0 && reported === connected.length) {
      if (this._phase === 'running') out.push(...this.stop(now));
      if (this._phase === 'awaitingResults') out.push(...this.decide());
      return out;
    }
    if (this.majorityAtMs === null && reported * 2 > connected.length) this.majorityAtMs = now;
    if (this._phase === 'running' && this.majorityAtMs !== null && now - this.majorityAtMs >= this.opts.resultWaitMs) {
      out.push(...this.stop(now));
      out.push(...this.decide());
    }
    return out;
  }

  private stop(now: number): Outbound[] {
    const out: Outbound[] = [];
    if (this.confirmedTick > this.lastBundledTick) {
      out.push({ to: 'all', msg: this.bundle(this.lastBundledTick + 1, this.confirmedTick) });
      this.lastBundledTick = this.confirmedTick;
    }
    this._phase = 'awaitingResults';
    this.stoppedAtMs = now;
    return out;
  }

  /** Call on every alarm / timer. Confirms due ticks, emits bundles, handles disconnect takeover and result timeout. */
  advance(now: number): Outbound[] {
    const out: Outbound[] = [];
    if (this._phase === 'running') {
      for (const [slot, c] of this.conns) {
        // REQ-NET-013: silence counts as a disconnect (a half-open socket never fires close)
        if (c.connected && !this.results.has(slot) && now - Math.max(c.lastMsgAt ?? this.startAtMs, this.startAtMs) >= this.config.net.disconnectGraceMs) {
          c.connected = false;
          c.disconnectedAt = Math.max(c.lastMsgAt ?? this.startAtMs, this.startAtMs);
        }
        if (!c.connected && !c.cpu && (c.disconnectedAt === null ? !c.everConnected && now - this.startAtMs >= this.config.net.disconnectGraceMs : now - c.disconnectedAt >= this.config.net.disconnectGraceMs)) {
          // REQ-NET-006: deterministic CPU takeover, inserted as an input for everyone
          this.addCmd(this.confirmedTick + 1, slot, CMD.CPU_TAKEOVER);
          c.cpu = true;
        }
      }
      const target = Math.min(this.dueTick(now), this.maxTicks - 1);
      while (this.confirmedTick < target) {
        const t = this.confirmedTick + 1;
        const m = this.pending.get(t);
        if (m) {
          for (const slot of [...m.keys()].sort((a, b) => a - b)) {
            const cmd = m.get(slot)!;
            if (cmd !== 0) this.log.push([t, slot, cmd]);
          }
          this.pending.delete(t);
        }
        this.confirmedTick = t;
      }
      if (this.confirmedTick - this.lastBundledTick >= this.config.net.bundleIntervalTicks) {
        out.push({ to: 'all', msg: this.bundle(this.lastBundledTick + 1, this.confirmedTick) });
        this.lastBundledTick = this.confirmedTick;
      }
      if (this.confirmedTick >= this.maxTicks - 1) out.push(...this.stop(now));
      else if (this.results.size > 0) out.push(...this.checkResults(now)); // disconnects / majority timeout
    }
    if (this._phase === 'awaitingResults' && this.stoppedAtMs !== null && now - this.stoppedAtMs >= this.opts.resultWaitMs) out.push(...this.decide());
    return out;
  }

  /** A player reported foul play: forces server verification (or, after the result, keeps the replay). */
  report() { this.reported = true; }

  /**
   * REQ-OPS-001: why this race's replay must survive the retention sweep (null = may be deleted).
   * Reported, disputed (suspects / desync), verified or void races are kept for support and audits.
   */
  retentionHold(): string | null {
    if (this.reported) return 'reported';
    if (this.desync.size > 0) return 'desync';
    const f = this._final;
    if (!f) return null;
    if (f.status === 'void') return 'void';
    if (f.suspects.length > 0) return 'disputed';
    if (f.via === 'verifier') return 'verified';
    return null;
  }

  private finalMsg(): ServerMessage {
    const f = this._final!;
    return { t: 'final', status: f.status, order: f.order, h: f.hash };
  }

  /** REQ-NET-008 consensus rules. */
  private decide(): Outbound[] {
    const reporters = [...this.results.entries()];
    const counts = new Map<string, { n: number; order: number[] }>();
    for (const [, r] of reporters) {
      const c = counts.get(r.h);
      if (c) c.n++;
      else counts.set(r.h, { n: 1, order: r.order });
    }
    const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const ranked = this.config.mode === 'ranked';
    const humans = this.humanSlots.length;
    let verify = false;
    if (this.reported) verify = true;
    else if (reporters.length === 0) verify = true;
    else if (humans === 1) verify = ranked; // tutorial / solo: the lone client is trusted unless ranked
    else if (reporters.length < 2) verify = true; // one voice among several humans proves nothing
    else {
      // quorum: the winning hash needs 2/3 of all human slots (not just of those who reported)
      const ok = best !== undefined && best[1].n >= 2 && best[1].n * 3 >= humans * 2;
      verify = !ok || this.opts.rng.nextU32() / 0x100000000 < this.opts.verifySampleRate;
    }

    if (verify) {
      this._phase = 'verifying';
      return [{ to: 'all', msg: { t: 'final', status: 'verifying', order: best?.[1].order ?? [], h: best?.[0] ?? '' } }];
    }
    const [hash, { order }] = best!;
    this._final = { status: 'confirmed', order, hash, via: 'consensus', suspects: reporters.filter(([, r]) => r.h !== hash).map(([s]) => s) };
    const ft = agreedFinishTicks(reporters.filter(([, r]) => r.h === hash).map(([, r]) => r), order.length);
    if (ft) this._final.finishTicks = ft;
    this._phase = 'final';
    return [{ to: 'all', msg: this.finalMsg() }];
  }

  /** Apply the verifier's re-simulation (null = verifier unavailable → race void). */
  applyVerification(out: VerifierOutput | null): Outbound[] {
    if (this._phase !== 'verifying') return [];
    if (!out) this._final = { status: 'void', order: [], hash: '', via: 'none', suspects: [] };
    else this._final = { status: 'confirmed', order: out.order, hash: out.resultHash, via: 'verifier', suspects: [...this.results.entries()].filter(([, r]) => r.h !== out.resultHash).map(([s]) => s), finishTicks: out.finishTicks };
    this._phase = 'final';
    return [{ to: 'all', msg: this.finalMsg() }];
  }

  replayLog(): ReplayLog {
    return { v: 1, config: this.config, endTick: this.confirmedTick, inputs: this.log.map((x) => [...x] as InputTriple) };
  }

  toJSON(): RoomSnapshot {
    return {
      config: this.config, startAtMs: this.startAtMs, opts: { verifySampleRate: this.opts.verifySampleRate, resultWaitMs: this.opts.resultWaitMs },
      conns: [...this.conns.entries()].map(([k, v]) => [k, { ...v }]),
      pending: [...this.pending.entries()].map(([t, m]) => [t, [...m.entries()]]),
      log: this.log, confirmedTick: this.confirmedTick, lastBundledTick: this.lastBundledTick, phase: this._phase, stoppedAtMs: this.stoppedAtMs, majorityAtMs: this.majorityAtMs,
      checksums: [...this.checksums.entries()].map(([t, m]) => [t, [...m.entries()]]), desync: [...this.desync],
      results: [...this.results.entries()], reported: this.reported, final: this._final,
    };
  }

  static fromJSON(s: RoomSnapshot, rng: Rng): RaceRoomCore {
    const r = new RaceRoomCore(s.config, s.startAtMs, { ...s.opts, rng });
    r.conns = new Map(s.conns.map(([k, v]) => [k, { ...v }]));
    r.pending = new Map(s.pending.map(([t, e]) => [t, new Map(e)]));
    r.log = s.log.map((x) => [...x] as InputTriple);
    r.confirmedTick = s.confirmedTick;
    r.lastBundledTick = s.lastBundledTick;
    r._phase = s.phase;
    r.stoppedAtMs = s.stoppedAtMs;
    r.majorityAtMs = s.majorityAtMs ?? null;
    r.checksums = new Map(s.checksums.map(([t, e]) => [t, new Map(e)]));
    r.desync = new Set(s.desync);
    r.results = new Map(s.results);
    r.reported = s.reported;
    r._final = s.final;
    return r;
  }
}

/** Finish ticks are trusted only when every client that agreed on the hash sent the same array. */
function agreedFinishTicks(agreeing: ReportedResult[], n: number): number[] | null {
  const first = agreeing[0]?.finishTicks;
  if (!first || first.length !== n) return null;
  return agreeing.every((r) => r.finishTicks && r.finishTicks.length === n && r.finishTicks.every((v, i) => v === first[i])) ? [...first] : null;
}

/**
 * Lower bound on the first possible finish tick: gate + distance at an over-estimated top speed
 * (every speed bonus at once, no acceleration). Used only to reject impossibly early results.
 */
export function minPlausibleFinishTick(config: RaceStartConfig): number {
  const r = config.ruleset as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const vmax = n('baseCruiseSpeedMmPerSec') + n('speedStatBonusMmPerSecPer1000') + n('spurtSpeedBonusMaxMmPerSec') + n('whipSpeedBonusMmPerSec');
  if (vmax <= 0) return 0;
  const boosted = Math.ceil((vmax * (1000 + Math.max(0, n('startBoostPermille')))) / 1000);
  const raceTicks = Math.floor((config.track.distanceM * 1000 * config.net.tickHz) / boosted);
  return Math.max(0, n('gateOpenTick') + raceTicks);
}
