import { engineMismatch } from '../domain/maintenance.js';
import { DurableObject } from 'cloudflare:workers';
import type { StartVisuals } from '../domain/visuals.js';
import type { Env } from '../env.js';
import { RaceRoomCore, DEFAULT_ROOM_OPTIONS, type Outbound, type RoomPhase, type RoomSnapshot } from '../domain/raceRoom.js';
import { clientMessageSchema, type RaceStartConfig, type ReplayLog } from '../domain/schemas.js';
import { cryptoRng } from '../domain/rng.js';
import { HttpVerifierClient } from '../domain/verifier.js';
import type { Rating } from '../domain/rating.js';
import { verifyTicket } from '../http/ticket.js';
import { admitSpectator } from '../domain/spectate.js';
import { driveSettlement, newSettleMeta, upgradeSettleMeta, type SettleMeta } from '../race/settlement.js';
import { dismissSettlementItem, retrySettlementItem, settlementDeadLetters, type DeadLetterItem, type RetryOutcome } from '../ops/deadLetter.js';
import { newlyDead, reportDeadLetters } from './deadLetters.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import type { PlayerDO } from './player.js';

/**
 * Per-socket state, kept by the runtime across hibernation. Spectators (REQ-SPEC-*) have slot null and
 * `spec` set: `sent` = last tick sent to them, `fin` = whether they already got the definitive final.
 */
interface Attachment { slot: number | null; spec?: { sent: number; fin: boolean; playerId?: string } }

/** REQ-SPEC-005: default spectator cap per room (env SPECTATOR_LIMIT overrides). */
export const DEFAULT_SPECTATOR_LIMIT = 200;

const WATCHDOG_MS = 30_000;

/**
 * One race = one Durable Object (REQ-NET-*). WebSockets use the hibernation API (no duration charge
 * while idle, REQ-NET-011); alarms drive the tick clock only while the race is running, and drive
 * verification/settlement afterwards (REQ-NET-014).
 *
 * Durability (REQ-NET-014): the room snapshot is written before any bundle/final/desync leaves the
 * object (the output gate holds outgoing messages until the write is durable), and on every phase
 * change, hello and result. A restart therefore never re-confirms ticks that clients already ran.
 */
export class RaceRoomDO extends DurableObject<Env> {
  private core: RaceRoomCore | null = null;
  private meta: SettleMeta | null = null;
  private driving = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get<RoomSnapshot>('core');
      if (snap) this.core = RaceRoomCore.fromJSON(snap, cryptoRng);
      const meta = await ctx.storage.get<SettleMeta>('meta');
      this.meta = meta ? upgradeSettleMeta(meta) : null;
    });
  }

  private sampleRate() {
    const v = Number(this.env.VERIFY_SAMPLE_RATE ?? DEFAULT_ROOM_OPTIONS.verifySampleRate);
    return Number.isFinite(v) ? v : DEFAULT_ROOM_OPTIONS.verifySampleRate;
  }

  private spectatorLimit() {
    const v = Number(this.env.SPECTATOR_LIMIT ?? DEFAULT_SPECTATOR_LIMIT);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SPECTATOR_LIMIT;
  }

  async init(o: { config: RaceStartConfig; startAtMs: number; ratings: Record<string, Rating>; eventId?: string | null; visuals?: StartVisuals; spectateDelayMs?: number }) {
    // idempotent: a repeated init (same raceId) keeps the room as it is and returns what it really runs, so a
    // resumed creation (tournament heats, QA r7 #5) hands out tickets for this room's slots and start
    if (this.core) return { config: this.core.config, startAtMs: this.core.startAtMs, existed: true };
    this.core = new RaceRoomCore(o.config, o.startAtMs, { verifySampleRate: this.sampleRate(), resultWaitMs: DEFAULT_ROOM_OPTIONS.resultWaitMs, rng: cryptoRng, ...(o.visuals ? { visuals: o.visuals } : {}), ...(o.spectateDelayMs !== undefined ? { spectateDelayMs: o.spectateDelayMs } : {}) });
    this.meta = newSettleMeta(o.ratings, o.eventId ?? null);
    await this.persist();
    await this.ctx.storage.setAlarm(o.startAtMs);
    return { config: o.config, startAtMs: o.startAtMs, existed: false };
  }

  private async persist() {
    if (!this.core) return;
    this.ctx.storage.put('core', this.core.toJSON());
    if (this.meta) this.ctx.storage.put('meta', this.meta);
    await this.ctx.storage.sync();
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.core) return new Response('race not found', { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ slot: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(out: Outbound[]) {
    if (out.length === 0) return;
    const sockets = this.ctx.getWebSockets();
    for (const o of out) {
      const data = JSON.stringify(o.msg);
      for (const ws of sockets) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.slot === null || a?.slot === undefined) continue;
        if (o.to === 'all' || o.to === a.slot) {
          try { ws.send(data); } catch { /* closed */ }
        }
      }
    }
  }

  private spectators(): [WebSocket, Attachment & { spec: { sent: number; fin: boolean } }][] {
    const out: [WebSocket, Attachment & { spec: { sent: number; fin: boolean } }][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.spec) out.push([ws, a as Attachment & { spec: { sent: number; fin: boolean } }]);
    }
    return out;
  }

  /**
   * REQ-SPEC-003/005: delayed, batched fan-out to spectators. Spectators who are at the same tick share one
   * serialized bundle; a socket is written at most once per bundle interval (or when the race ends).
   */
  private flushSpectators(now: number, force = false) {
    const core = this.core;
    if (!core) return;
    const frontier = core.spectatorFrontier(now);
    const interval = core.config.net.bundleIntervalTicks;
    const cache = new Map<number, string>();
    for (const [ws, a] of this.spectators()) {
      let changed = false;
      const behind = frontier - a.spec.sent;
      if (behind > 0 && (force || behind >= interval || frontier >= core.lastSpectatorTick)) {
        let data = cache.get(a.spec.sent);
        if (data === undefined) cache.set(a.spec.sent, (data = JSON.stringify(core.bundleRange(a.spec.sent + 1, frontier))));
        try { ws.send(data); } catch { /* closed */ }
        a.spec.sent = frontier;
        changed = true;
      }
      if (!a.spec.fin) {
        const fin = core.spectatorFinal(a.spec.sent);
        if (fin) {
          try { ws.send(JSON.stringify(fin)); } catch { /* closed */ }
          a.spec.fin = true;
          changed = true;
        }
      }
      if (changed) ws.serializeAttachment(a);
    }
  }

  /** True while some spectator still has ticks or the final to receive (keeps the alarm going). */
  private spectatorsPending(): boolean {
    const core = this.core;
    if (!core) return false;
    return this.spectators().some(([, a]) => a.spec.sent < core.lastSpectatorTick || (!a.spec.fin && core.phase === 'final'));
  }

  private async helloSpectator(ws: WebSocket, playerId: string, lastTick: number, now: number) {
    const core = this.core!;
    // QA r7 #8: one spectator socket per player (a newer one replaces the older), so one user cannot fill the cap
    const others = this.spectators().filter(([w]) => w !== ws).map(([w, a]) => ({ ws: w, playerId: a.spec.playerId ?? null }));
    const d = admitSpectator(others, playerId, this.spectatorLimit());
    if (!d.admit) {
      ws.send(JSON.stringify({ t: 'err', code: 'SPECTATORS_FULL' }));
      ws.close(4003, 'spectators full');
      return;
    }
    for (const old of d.replace) { old.serializeAttachment({ slot: null } satisfies Attachment); old.close(4000, 'replaced'); }
    ws.send(JSON.stringify(core.spectatorStart()));
    ws.serializeAttachment({ slot: null, spec: { sent: Math.max(-1, Math.min(lastTick, core.spectatorFrontier(now))), fin: false, playerId } } satisfies Attachment);
    this.flushSpectators(now, true);
    await this.scheduleAlarm();
  }

  /** Outbound that changes what clients have seen (ticks, verdicts) must be durable before it is sent. */
  private static mustPersist(out: Outbound[], phaseBefore: RoomPhase, phaseAfter: RoomPhase) {
    return phaseBefore !== phaseAfter || out.some((o) => o.msg.t === 'b' || o.msg.t === 'final' || o.msg.t === 'desync');
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const core = this.core;
    if (!core) return ws.close(1011, 'no race');
    let parsed;
    try {
      parsed = clientMessageSchema.safeParse(JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) return ws.send(JSON.stringify({ t: 'err', code: 'BAD_MESSAGE' }));
    const msg = parsed.data;
    const now = Date.now();
    const att = ws.deserializeAttachment() as Attachment;
    const phaseBefore = core.phase;
    if (msg.t === 'hello') {
      try {
        const t = await verifyTicket(msg.token, this.env.TICKET_SECRET, core.config.raceId, now);
        // REQ-MNT-008 (§46): an app whose engine cannot run this race is refused before it takes a seat (no reconnect loop)
        if (engineMismatch(msg.engine)) {
          ws.send(JSON.stringify({ t: 'err', code: 'VERSION_MISMATCH' }));
          ws.close(4026, 'version mismatch');
          return;
        }
        if (t.slot < 0) return await this.helloSpectator(ws, t.playerId, msg.lastTick, now); // REQ-SPEC-002
        // one socket per slot: close older ones
        for (const other of this.ctx.getWebSockets()) {
          const oa = other.deserializeAttachment() as Attachment | null;
          if (other !== ws && oa?.slot === t.slot) { other.serializeAttachment({ slot: null }); other.close(4000, 'replaced'); }
        }
        ws.serializeAttachment({ slot: t.slot } satisfies Attachment);
        const out = core.hello(t.slot, msg.lastTick, now);
        await this.persist(); // connection state and a pending HUMAN_RESUME
        this.send(out);
      } catch {
        ws.send(JSON.stringify({ t: 'err', code: 'UNAUTHORIZED' }));
        ws.close(4001, 'unauthorized');
      }
      return;
    }
    if (att.spec) {
      // REQ-SPEC-002: read-only — spectators never send inputs, checksums or results
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: now }));
      return ws.send(JSON.stringify({ t: 'err', code: 'SPECTATOR_READ_ONLY' }));
    }
    if (att.slot === null) return ws.send(JSON.stringify({ t: 'err', code: 'NOT_IN_RACE' }));
    const out = core.message(att.slot, msg, now);
    if (msg.t === 'res' || RaceRoomDO.mustPersist(out, phaseBefore, core.phase)) await this.persist();
    this.send(out);
    await this.scheduleAlarm();
  }

  override async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (this.core && a?.slot !== null && a?.slot !== undefined) {
      this.core.disconnect(a.slot, Date.now());
      await this.persist();
    }
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  override async alarm() {
    const core = this.core;
    if (!core) return;
    const phaseBefore = core.phase;
    const out = core.advance(Date.now());
    if (RaceRoomDO.mustPersist(out, phaseBefore, core.phase)) await this.persist();
    this.send(out);
    this.flushSpectators(Date.now());
    if (core.phase === 'verifying' || (core.phase === 'final' && this.meta && !this.meta.settled)) await this.drive();
    this.flushSpectators(Date.now());
    await this.scheduleAlarm();
  }

  /** Verification and settlement run only here (never from a socket event), one at a time. */
  private async drive() {
    if (this.driving || !this.core || !this.meta) return;
    this.driving = true;
    try {
      // watchdog: if we die mid-call, the alarm fires again and resumes from the persisted step
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      const core = this.core;
      const deadBefore = settlementDeadLetters(this.meta);
      const r = await driveSettlement(core, this.meta, {
        verify: (log) => new HttpVerifierClient(this.env.VERIFIER_URL, undefined, undefined, this.env.VERIFIER_TOKEN).verify(log),
        putReplay: (log, hold) => this.putReplay(log, hold),
        applyRace: async (pid, res) => {
          const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
          unwrap(await stub.invoke('applyRace', [pid, res]));
        },
        raceFinished: async (pids) => {
          const mm = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('ranked-jp')) as unknown as { raceFinished(r: string, p: string[]): Promise<Envelope<unknown>> };
          unwrap(await mm.raceFinished(core.config.raceId, pids));
        },
        persist: () => this.persist(),
        integrity: async (r) => {
          if (!this.env.INTEGRITY) return;
          const integ = this.env.INTEGRITY.get(this.env.INTEGRITY.idFromName('global')) as unknown as { recordRace(x: typeof r): Promise<Envelope<unknown>> };
          unwrap(await integ.recordRace(r));
        },
      }, Date.now());
      this.send(r.out);
      await reportDeadLetters(this.env, 'settlement', core.config.raceId, newlyDead(deadBefore, settlementDeadLetters(this.meta)), Date.now());
    } finally {
      this.driving = false;
    }
  }

  // ---- dead letters (REQ-OPS-041): players whose result could not be applied past the retry budget ----
  async dlList(): Promise<Envelope<DeadLetterItem[]>> { return wrap(() => settlementDeadLetters(this.meta)); }
  async dlRetry(playerId: string): Promise<Envelope<RetryOutcome>> {
    return wrap(async () => {
      if (!this.meta) return { ok: false, error: 'race not found' };
      const out = await retrySettlementItem(this.meta, playerId, async (pid, res) => {
        const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
        unwrap(await stub.invoke('applyRace', [pid, res]));
      });
      await this.persist();
      return out;
    });
  }
  async dlDismiss(playerId: string, by: string, note: string, now: number): Promise<Envelope<boolean>> {
    return wrap(async () => {
      if (!this.meta) return false;
      dismissSettlementItem(this.meta, playerId, by, note, now);
      await this.persist();
      return true;
    });
  }

  private async putReplay(log: ReplayLog, hold: string | null) {
    await this.env.REPLAYS.put(`replays/${log.config.raceId}.json`, JSON.stringify(log), hold ? { customMetadata: { hold } } : {});
  }

  private async scheduleAlarm() {
    const core = this.core;
    if (!core) return;
    let next: number | null = null;
    if (core.phase === 'running' || core.phase === 'awaitingResults') {
      const interval = (1000 / core.config.net.tickHz) * core.config.net.bundleIntervalTicks;
      next = Math.max(Date.now() + interval, core.startAtMs);
    } else if (core.phase === 'verifying' || (core.phase === 'final' && this.meta && !this.meta.settled)) {
      next = this.meta?.retryAt ?? Date.now();
    }
    if (this.spectatorsPending()) {
      // REQ-SPEC-003: keep pacing the delayed stream after the players' race has stopped
      const interval = (1000 / core.config.net.tickHz) * core.config.net.bundleIntervalTicks;
      const t = Math.max(Date.now() + interval, core.startAtMs);
      next = next === null ? t : Math.min(next, t);
    }
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
  }

  async report(playerId: string) {
    if (!this.core || this.core.slotOf(playerId) === null) return { ok: false };
    this.core.report();
    await this.persist();
    // after the result: keep the replay out of the retention sweep (REQ-OPS-001)
    if (this.meta?.replayStored) await this.putReplay(this.core.replayLog(), this.core.retentionHold());
    return { ok: true };
  }

  /** REQ-TOUR-006: phase, verdict, slot → player and no-shows of this race (tournament heats poll this). */
  async heatResult() {
    return this.core?.heatSummary() ?? null;
  }

  /** REQ-SPEC-005: live spectator count (for the live-race list). */
  async spectatorCount() {
    return this.spectators().length;
  }

  async replay() {
    return this.core?.replayLog() ?? null;
  }
}

export type { PlayerDO };
