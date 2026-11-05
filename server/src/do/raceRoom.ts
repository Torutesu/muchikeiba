import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { RaceRoomCore, DEFAULT_ROOM_OPTIONS, type Outbound, type RoomPhase, type RoomSnapshot } from '../domain/raceRoom.js';
import { clientMessageSchema, type RaceStartConfig, type ReplayLog } from '../domain/schemas.js';
import { cryptoRng } from '../domain/rng.js';
import { HttpVerifierClient } from '../domain/verifier.js';
import type { Rating } from '../domain/rating.js';
import { verifyTicket } from '../http/ticket.js';
import { driveSettlement, newSettleMeta, upgradeSettleMeta, type SettleMeta } from '../race/settlement.js';
import { unwrap, type Envelope } from './rpc.js';
import type { PlayerDO } from './player.js';

interface Attachment { slot: number | null }

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

  async init(o: { config: RaceStartConfig; startAtMs: number; ratings: Record<string, Rating>; eventId?: string | null }) {
    if (this.core) return; // idempotent
    this.core = new RaceRoomCore(o.config, o.startAtMs, { verifySampleRate: this.sampleRate(), resultWaitMs: DEFAULT_ROOM_OPTIONS.resultWaitMs, rng: cryptoRng });
    this.meta = newSettleMeta(o.ratings, o.eventId ?? null);
    await this.persist();
    await this.ctx.storage.setAlarm(o.startAtMs);
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
    if (core.phase === 'verifying' || (core.phase === 'final' && this.meta && !this.meta.settled)) await this.drive();
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
    } finally {
      this.driving = false;
    }
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

  async replay() {
    return this.core?.replayLog() ?? null;
  }
}

export type { PlayerDO };
