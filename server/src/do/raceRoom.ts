import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { RaceRoomCore, DEFAULT_ROOM_OPTIONS, type Outbound, type RoomSnapshot } from '../domain/raceRoom.js';
import { clientMessageSchema, type RaceStartConfig } from '../domain/schemas.js';
import { cryptoRng } from '../domain/rng.js';
import { HttpVerifierClient } from '../domain/verifier.js';
import type { Rating } from '../domain/rating.js';
import { verifyTicket } from '../http/ticket.js';
import { settleRace } from '../race/orchestrate.js';
import { unwrap, type Envelope } from './rpc.js';
import type { PlayerDO } from './player.js';

interface Meta { ratings: Record<string, Rating>; settled: boolean }
interface Attachment { slot: number | null }

/**
 * One race = one Durable Object (REQ-NET-*). WebSockets use the hibernation API (no duration charge
 * while idle, REQ-NET-011); alarms drive the tick clock only while the race is running.
 */
export class RaceRoomDO extends DurableObject<Env> {
  private core: RaceRoomCore | null = null;
  private meta: Meta | null = null;
  private lastPersistTick = -1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get<RoomSnapshot>('core');
      if (snap) this.core = RaceRoomCore.fromJSON(snap, cryptoRng);
      this.meta = (await ctx.storage.get<Meta>('meta')) ?? null;
    });
  }

  private sampleRate() {
    const v = Number(this.env.VERIFY_SAMPLE_RATE ?? DEFAULT_ROOM_OPTIONS.verifySampleRate);
    return Number.isFinite(v) ? v : DEFAULT_ROOM_OPTIONS.verifySampleRate;
  }

  async init(o: { config: RaceStartConfig; startAtMs: number; ratings: Record<string, Rating> }) {
    if (this.core) return; // idempotent
    this.core = new RaceRoomCore(o.config, o.startAtMs, { verifySampleRate: this.sampleRate(), resultWaitMs: DEFAULT_ROOM_OPTIONS.resultWaitMs, rng: cryptoRng });
    this.meta = { ratings: o.ratings, settled: false };
    await this.ctx.storage.put('meta', this.meta);
    await this.persist();
    await this.ctx.storage.setAlarm(o.startAtMs);
  }

  private async persist() {
    if (!this.core) return;
    await this.ctx.storage.put('core', this.core.toJSON());
    this.lastPersistTick = this.core.lastConfirmedTick;
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
    if (msg.t === 'hello') {
      try {
        const t = await verifyTicket(msg.token, this.env.TICKET_SECRET, core.config.raceId, now);
        // one socket per slot: close older ones
        for (const other of this.ctx.getWebSockets()) {
          const oa = other.deserializeAttachment() as Attachment | null;
          if (other !== ws && oa?.slot === t.slot) { other.serializeAttachment({ slot: null }); other.close(4000, 'replaced'); }
        }
        ws.serializeAttachment({ slot: t.slot } satisfies Attachment);
        this.send(core.hello(t.slot, msg.lastTick, now));
      } catch {
        ws.send(JSON.stringify({ t: 'err', code: 'UNAUTHORIZED' }));
        ws.close(4001, 'unauthorized');
      }
      return;
    }
    if (att.slot === null) return ws.send(JSON.stringify({ t: 'err', code: 'NOT_IN_RACE' }));
    this.send(core.message(att.slot, msg, now));
    await this.afterChange();
  }

  override async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (this.core && a?.slot !== null && a?.slot !== undefined) this.core.disconnect(a.slot, Date.now());
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  override async alarm() {
    const core = this.core;
    if (!core) return;
    this.send(core.advance(Date.now()));
    await this.afterChange();
  }

  private async afterChange() {
    const core = this.core!;
    if (core.phase === 'running' || core.phase === 'awaitingResults') {
      if (core.lastConfirmedTick - this.lastPersistTick >= core.config.net.tickHz) await this.persist();
      const interval = (1000 / core.config.net.tickHz) * core.config.net.bundleIntervalTicks;
      const next = Math.max(Date.now() + interval, core.startAtMs);
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
      return;
    }
    if (core.phase === 'verifying') {
      const log = core.replayLog();
      await this.env.REPLAYS.put(`replays/${core.config.raceId}.json`, JSON.stringify(log));
      let result = null;
      try {
        result = await new HttpVerifierClient(this.env.VERIFIER_URL).verify(log);
      } catch (e) {
        console.error('verifier failed', e);
      }
      this.send(core.applyVerification(result));
    }
    if (core.phase === 'final') await this.settle();
  }

  private async settle() {
    const core = this.core!;
    if (!this.meta || this.meta.settled || !core.final) return;
    await this.env.REPLAYS.put(`replays/${core.config.raceId}.json`, JSON.stringify(core.replayLog()));
    const results = settleRace(core.config, core.final, this.meta.ratings);
    for (const [pid, r] of Object.entries(results)) {
      const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
      try {
        unwrap(await stub.invoke('applyRace', [pid, r]));
      } catch (e) {
        console.error('applyRace failed', pid, e);
      }
    }
    this.meta.settled = true;
    await this.ctx.storage.put('meta', this.meta);
    await this.persist();
  }

  async report(playerId: string) {
    if (!this.core || this.core.slotOf(playerId) === null) return { ok: false };
    this.core.report();
    await this.persist();
    return { ok: true };
  }

  async replay() {
    return this.core?.replayLog() ?? null;
  }
}

export type { PlayerDO };
