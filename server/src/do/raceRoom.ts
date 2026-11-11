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
import {
  blockHidden, cheerAdmit, cheerableMode, cheerFanout, cheerSummary, cheerSummaryKey, emptyTally, tallyAdd, withCheerAdvert,
  CHEER_WINDOW_MS, type CheerRecipient, type CheerTally, type PendingCheer,
} from '../domain/cheer.js';
import { driveSettlement, newSettleMeta, upgradeSettleMeta, type SettleMeta } from '../race/settlement.js';
import { dismissSettlementItem, retrySettlementItem, settlementDeadLetters, type DeadLetterItem, type RetryOutcome } from '../ops/deadLetter.js';
import { newlyDead, reportDeadLetters } from './deadLetters.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import type { PlayerDO } from './player.js';

/**
 * Per-socket state, kept by the runtime across hibernation. Spectators (REQ-SPEC-*) have slot null and
 * `spec` set: `sent` = last tick sent to them, `fin` = whether they already got the definitive final.
 */
interface Attachment { slot: number | null; spec?: { sent: number; fin: boolean; playerId?: string; lc?: number } }
// REQ-CHEER-004 (§55): `spec.lc` = when this spectator's last cheer was accepted (the 2 s rate limit survives hibernation).

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
  // ---- 観戦中の応援 (REQ-CHEER-*, §55): kept beside the core, never inside it (no input, no log, no hash) ----
  /** Accepted cheers of the open window and when it opened (memory only: a window lost to eviction is just not shown). */
  private cheerWindow: PendingCheer[] = [];
  private cheerWindowAt: number | null = null;
  /** Block lists of the room's players and spectators (§47 single list), loaded on hello; absent = not known (fail closed). */
  private cheerLists = new Map<string, ReadonlySet<string>>();
  /** REQ-CHEER-004: last accepted cheer per player as well (a reconnect gets a fresh attachment; this keeps the pace). */
  private cheerLast = new Map<string, number>();
  /** REQ-CHEER-011: the race's aggregate (storage key `cheer`, written to R2 once at the end). */
  private tally: CheerTally = emptyTally();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const snap = await ctx.storage.get<RoomSnapshot>('core');
      if (snap) this.core = RaceRoomCore.fromJSON(snap, cryptoRng);
      const meta = await ctx.storage.get<SettleMeta>('meta');
      this.meta = meta ? upgradeSettleMeta(meta) : null;
      this.tally = (await ctx.storage.get<CheerTally>('cheer')) ?? emptyTally();
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

  /** REQ-CHEER-001/015: cheers are on for watchable modes unless the environment turns them off (`CHEERS = "off"`). */
  private cheersEnabled() {
    return !!this.core && this.env.CHEERS !== 'off' && cheerableMode(this.core.config.mode);
  }

  /** REQ-CHEER-008: one player's block list (the §47 single list), once per room. False = could not be read. */
  private async loadBlocks(pid: string): Promise<boolean> {
    if (this.cheerLists.has(pid)) return true;
    try {
      const stub = this.env.PLAYER.get(this.env.PLAYER.idFromName(pid)) as unknown as { invoke(m: string, a: unknown[]): Promise<Envelope<unknown>> };
      const r = unwrap(await stub.invoke('feedMutes', [pid])) as { muted: string[] };
      this.cheerLists.set(pid, new Set(r.muted));
      return true;
    } catch {
      return false;
    }
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
    ws.send(JSON.stringify(withCheerAdvert(core.spectatorStart(), this.cheersEnabled()))); // REQ-CHEER-003
    if (this.cheersEnabled()) await this.loadBlocks(playerId); // REQ-CHEER-008: before the first cheer in or out
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
        // REQ-CHEER-008: the racer's block list for the cheer indicator, without delaying the seat (no list yet = no cheers)
        if (this.cheersEnabled()) void this.loadBlocks(t.playerId);
        const out = core.hello(t.slot, msg.lastTick, now);
        await this.persist(); // connection state and a pending HUMAN_RESUME
        this.send(out);
      } catch {
        ws.send(JSON.stringify({ t: 'err', code: 'UNAUTHORIZED' }));
        ws.close(4001, 'unauthorized');
      }
      return;
    }
    if (msg.t === 'cheer') return await this.onCheer(ws, att, msg.slot, msg.kind, now); // REQ-CHEER-003..006
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

  /**
   * REQ-CHEER-003..006: a spectator's cheer joins the open window (the alarm sends it out, flushCheers). The rate limit is
   * taken before any await, so two cheers racing each other cannot both pass. Refusals are plain `err`s that no client
   * treats as fatal (RaceSession.FatalRoomErrors does not list them).
   */
  private async onCheer(ws: WebSocket, att: Attachment, slot: number, kind: PendingCheer['kind'], now: number) {
    const core = this.core!;
    const spec = att.spec;
    const last = Math.max(spec?.lc ?? -Infinity, (spec?.playerId && this.cheerLast.get(spec.playerId)) || -Infinity);
    const refusal = cheerAdmit({
      enabled: this.cheersEnabled(), spectator: !!spec, sentTick: spec?.sent ?? -1, fin: spec?.fin ?? true, lastAt: Number.isFinite(last) ? last : null,
      slot, entrants: core.config.entrants.length, now,
    });
    if (refusal || !spec) return ws.send(JSON.stringify({ t: 'err', code: refusal ?? 'NOT_SPECTATOR' }));
    if (!spec.playerId) return ws.send(JSON.stringify({ t: 'err', code: 'CHEER_UNAVAILABLE' }));
    spec.lc = now;
    this.cheerLast.set(spec.playerId, now);
    ws.serializeAttachment(att);
    if (!(await this.loadBlocks(spec.playerId))) return ws.send(JSON.stringify({ t: 'err', code: 'CHEER_UNAVAILABLE' }));
    this.cheerWindow.push({ from: spec.playerId, slot, kind });
    this.cheerWindowAt ??= now;
    tallyAdd(this.tally, spec.sent); // REQ-CHEER-011: the tick the sender was watching
    await this.scheduleAlarm();
  }

  /**
   * REQ-CHEER-005/007/008: close the window once it is CHEER_WINDOW_MS old — one `cheers` message per socket at most:
   * spectators still watching, and racers while the race runs. Each recipient's message leaves out cheers across a block.
   */
  private flushCheers(now: number) {
    const core = this.core;
    if (!core || this.cheerWindow.length === 0 || this.cheerWindowAt === null || now - this.cheerWindowAt < CHEER_WINDOW_MS) return;
    const cheers = this.cheerWindow;
    this.cheerWindow = [];
    this.cheerWindowAt = null;
    const recipients: CheerRecipient<WebSocket>[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      let pid: string | null = null;
      if (a?.spec) { if (a.spec.fin || a.spec.sent < 0) continue; pid = a.spec.playerId ?? null; }
      else if (a && a.slot !== null && a.slot !== undefined) { if (core.phase !== 'running') continue; pid = core.config.entrants[a.slot]?.playerId ?? null; }
      else continue;
      if (pid && !this.cheerLists.has(pid)) void this.loadBlocks(pid); // evicted memory: fetch again, show from the next window
      recipients.push({ key: ws, playerId: pid });
    }
    for (const [ws, data] of cheerFanout(cheers, recipients, blockHidden(this.cheerLists))) {
      if (data) try { ws.send(data); } catch { /* closed */ }
    }
    this.ctx.storage.put('cheer', this.tally); // small; durable with the next write
  }

  /** REQ-CHEER-011: once nobody can cheer any more, write the race's aggregate beside the replay log (once, only if there were cheers). */
  private async finishCheers() {
    const core = this.core;
    if (!core || core.phase !== 'final' || this.tally.written || this.tally.total === 0 || this.cheerWindow.length > 0 || this.spectatorsPending()) return;
    if (this.spectators().some(([, a]) => !a.spec.fin)) return;
    await this.env.REPLAYS.put(cheerSummaryKey(core.config.raceId), JSON.stringify(cheerSummary(this.tally)), { httpMetadata: { contentType: 'application/json' } });
    this.tally.written = true;
    await this.ctx.storage.put('cheer', this.tally);
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
    this.flushCheers(Date.now());
    try { await this.finishCheers(); } catch (e) { console.error('cheer summary not written', core.config.raceId, (e as Error).message); }
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
    if (this.cheerWindowAt !== null) {
      // REQ-CHEER-005: close an open cheer window on time even when nothing else needs the alarm
      const t = this.cheerWindowAt + CHEER_WINDOW_MS;
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
