/**
 * 再戦 (REQ-LINK-014..019, contracts/protocol.md §63.6): after a friend-room race, every racer may press 「再戦」. The first press
 * opens a window of `windowSec`; whoever pressed by its end (or as soon as everyone still in has pressed) goes into a new friend
 * room on the same conditions (a snapshot taken when the race started) and a new seed (a new race is created on start).
 *
 * Pure state, kept by the matchmaker object (one instance: presses from two players are processed one after the other). The
 * matchmaker settles due offers on its alarm and on any later request about the offer, so an offline player who comes back
 * sees the outcome. Players are left out — never told why — when they did not press, declined, are busy (racing / queued) when
 * the window closes, or block / are blocked by someone already in (in press order).
 */
import { AppError } from './errors.js';
import type { RoomConditions } from './presets.js';

export interface RematchPress<E> { playerId: string; at: number; entry: E; blocks: string[] }
export interface RematchOffer<E> {
  raceId: string; hostId: string; members: string[]; conditions: RoomConditions | null; offeredAt: number;
  presses: RematchPress<E>[]; declined: string[]; deadlineAt: number | null;
  outcome: null | { at: number; passphrase: string | null; members: string[]; hostId: string | null };
}
export type RematchReason = 'too_few' | 'not_included' | 'expired';
export interface RematchView {
  raceId: string; state: 'waiting' | 'opened' | 'closed'; reason: RematchReason | null; you: 'pressed' | 'declined' | 'none';
  pressed: number; eligible: number; windowSec: number; deadlineAt: number | null;
  room: { passphrase: string; members: number; host: boolean } | null;
}
export interface RematchRules { windowSec: number; offerMinutes: number }
/** What settling needs from the matchmaker: is the player free (not racing / queued), may they host a new room. */
export interface RematchEnv { isFree(playerId: string): boolean; mayHost(playerId: string): boolean }
export interface RematchPlan<E> { hostId: string; members: { playerId: string; entry: E }[] }

const notFound = () => new AppError('NOT_FOUND', 'no rematch for this race');

export class Rematches<E = unknown> {
  offers = new Map<string, RematchOffer<E>>();

  /** REQ-LINK-014: remembered when a friend-room race starts (members and the room's conditions as they were). */
  offer(raceId: string, hostId: string, members: string[], conditions: RoomConditions | null, now: number) {
    if (this.offers.has(raceId)) return;
    this.offers.set(raceId, { raceId, hostId, members: [...members], conditions: conditions ? structuredClone(conditions) : null, offeredAt: now, presses: [], declined: [], deadlineAt: null, outcome: null });
  }

  private get(raceId: string, playerId: string) {
    const o = this.offers.get(raceId);
    if (!o || !o.members.includes(playerId)) throw notFound();
    return o;
  }
  private expired(o: RematchOffer<E>, now: number, r: RematchRules) { return now >= o.offeredAt + r.offerMinutes * 60_000; }
  /** True when the offer should be settled now (window over, or everyone still in has pressed). */
  due(o: RematchOffer<E>, now: number) {
    if (o.outcome || o.deadlineAt === null) return false;
    if (now >= o.deadlineAt) return true;
    return o.members.every((m) => o.declined.includes(m) || o.presses.some((p) => p.playerId === m));
  }

  /** REQ-LINK-015/017: press (again = choose the horse again). Returns whether the offer is due now. */
  press(raceId: string, playerId: string, entry: E, blocks: string[], now: number, r: RematchRules): boolean {
    const o = this.get(raceId, playerId);
    if (o.outcome || this.expired(o, now, r) || (o.deadlineAt !== null && now >= o.deadlineAt)) return this.due(o, now);
    o.declined = o.declined.filter((x) => x !== playerId);
    const mine = o.presses.find((p) => p.playerId === playerId);
    if (mine) { mine.entry = entry; mine.blocks = [...blocks]; }
    else o.presses.push({ playerId, at: now, entry, blocks: [...blocks] });
    o.deadlineAt ??= now + r.windowSec * 1000;
    return this.due(o, now);
  }

  /** REQ-LINK-016: 「やめる」 — out of this rematch (a press before the window closes can come back). */
  decline(raceId: string, playerId: string, now: number): boolean {
    const o = this.get(raceId, playerId);
    if (o.outcome) return false;
    o.presses = o.presses.filter((p) => p.playerId !== playerId);
    if (!o.declined.includes(playerId)) o.declined.push(playerId);
    if (o.presses.length === 0) o.deadlineAt = null;
    return this.due(o, now);
  }

  /**
   * REQ-LINK-015/016: who goes in, in press order: free players with no block either way with anyone already in. Two or more →
   * a plan (host: the previous host when in and allowed to host, else the first one in who may). Fewer → null.
   */
  plan(raceId: string, env: RematchEnv): RematchPlan<E> | null {
    const o = this.offers.get(raceId);
    if (!o) return null;
    const inn: RematchPress<E>[] = [];
    for (const p of [...o.presses].sort((a, b) => a.at - b.at)) {
      if (!env.isFree(p.playerId)) continue;
      if (inn.some((q) => q.blocks.includes(p.playerId) || p.blocks.includes(q.playerId))) continue;
      inn.push(p);
    }
    if (inn.length < 2) return null;
    const host = inn.find((p) => p.playerId === o.hostId && env.mayHost(p.playerId)) ?? inn.find((p) => env.mayHost(p.playerId));
    if (!host) return null;
    return { hostId: host.playerId, members: [host, ...inn.filter((p) => p !== host)].map((p) => ({ playerId: p.playerId, entry: p.entry })) };
  }

  /** Records the outcome (a room, or none) and drops the entries (only ids stay). */
  settle(raceId: string, now: number, room: { passphrase: string; hostId: string; members: string[] } | null) {
    const o = this.offers.get(raceId);
    if (!o || o.outcome) return;
    o.outcome = { at: now, passphrase: room?.passphrase ?? null, members: room?.members ?? [], hostId: room?.hostId ?? null };
    o.presses = o.presses.map((p) => ({ ...p, entry: null as unknown as E, blocks: [] }));
  }

  view(raceId: string, playerId: string, now: number, r: RematchRules): RematchView {
    const o = this.get(raceId, playerId);
    const you = o.declined.includes(playerId) ? 'declined' : o.presses.some((p) => p.playerId === playerId) ? 'pressed' : 'none';
    const base = { raceId, you, pressed: o.presses.length, eligible: o.members.length - o.declined.length, windowSec: r.windowSec, deadlineAt: o.deadlineAt } as const;
    if (o.outcome) {
      const inRoom = o.outcome.passphrase !== null && o.outcome.members.includes(playerId);
      if (inRoom) return { ...base, state: 'opened', reason: null, room: { passphrase: o.outcome.passphrase!, members: o.outcome.members.length, host: o.outcome.hostId === playerId } };
      return { ...base, state: 'closed', reason: o.outcome.passphrase === null ? 'too_few' : 'not_included', room: null };
    }
    if (this.expired(o, now, r) && o.deadlineAt === null) return { ...base, state: 'closed', reason: 'expired', room: null };
    return { ...base, state: 'waiting', reason: null, room: null };
  }

  /** Offers whose window is over (the alarm settles them). */
  dueIds(now: number) { return [...this.offers.values()].filter((o) => this.due(o, now)).map((o) => o.raceId); }
  /** The next time something is due (window ends), or null. */
  nextWake() {
    const t = [...this.offers.values()].filter((o) => !o.outcome && o.deadlineAt !== null).map((o) => o.deadlineAt!);
    return t.length ? Math.min(...t) : null;
  }
  /** Old offers are dropped (the outcome is kept as long as the offer, so a late `GET` still sees it). */
  prune(now: number, r: RematchRules) {
    for (const [k, o] of this.offers) {
      const end = Math.max(o.offeredAt + r.offerMinutes * 60_000, (o.outcome?.at ?? 0) + 30 * 60_000);
      if (now >= end && !this.due(o, now)) this.offers.delete(k);
    }
  }

  toJSON() { return [...this.offers.values()]; }
  static fromJSON<E>(rows: RematchOffer<E>[] | undefined): Rematches<E> {
    const r = new Rematches<E>();
    for (const o of rows ?? []) r.offers.set(o.raceId, o);
    return r;
  }
}
