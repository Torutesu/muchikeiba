import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { PublicProfile } from './stats.js';

/**
 * Friends (REQ-SOCIAL-*). Each player's lists live in their own PlayerState; a request touches two
 * players, so the FriendsService below performs idempotent per-player steps in a fixed order and
 * compensates when the second step fails. Friend codes are resolved through a sharded directory.
 */

export const DIRECTORY_SHARDS = 16;
const CODE_SPACE = 10_000_000; // 7 digits per shard
const MULT = 7_919_993; // coprime with 10^7 → (seq * MULT + ADD) mod 10^7 is a bijection
const ADD = 1_234_567;

/** FNV-1a 32-bit → shard index. Stable across runtimes. */
export function shardOf(playerId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DIRECTORY_SHARDS;
}

/** 9-digit friend code: 2-digit shard + a permuted per-shard sequence number (unique, non-guessable order). */
export function friendCode(shard: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 0 || seq >= CODE_SPACE) throw new AppError('CONFIG_INVALID', 'friend code space exhausted');
  const permuted = Number((BigInt(seq) * BigInt(MULT) + BigInt(ADD)) % BigInt(CODE_SPACE));
  return String(shard).padStart(2, '0') + String(permuted).padStart(7, '0');
}

export function shardOfCode(code: string): number | null {
  if (!/^\d{9}$/.test(code)) return null;
  const s = Number(code.slice(0, 2));
  return s < DIRECTORY_SHARDS ? s : null;
}

// ---- per-player steps (run inside PlayerService.tx) ----

const isFriend = (s: PlayerState, id: string) => s.friends.ids.includes(id);
const dropIncoming = (s: PlayerState, id: string) => { s.friends.incoming = s.friends.incoming.filter((x) => x.from !== id); };
const dropOutgoing = (s: PlayerState, id: string) => { s.friends.outgoing = s.friends.outgoing.filter((x) => x.to !== id); };
const addFriend = (s: PlayerState, id: string) => { if (!isFriend(s, id)) s.friends.ids.push(id); dropIncoming(s, id); dropOutgoing(s, id); };

export type SendOutcome = 'sent' | 'already_sent' | 'already_friends' | 'mutual';

/** Sender side. If the target already asked us, this becomes an accept ('mutual'). */
export function friendSend(m: Master, s: PlayerState, toId: string, now: number): SendOutcome {
  if (toId === s.id) throw new AppError('BAD_REQUEST', 'cannot befriend yourself');
  if (isFriend(s, toId)) return 'already_friends';
  if (s.friends.incoming.some((x) => x.from === toId)) {
    if (s.friends.ids.length >= m.progression.social.maxFriends) throw new AppError('FRIEND_LIMIT');
    addFriend(s, toId);
    return 'mutual';
  }
  if (s.friends.outgoing.some((x) => x.to === toId)) return 'already_sent';
  const { maxFriends, maxOutgoing } = m.progression.social;
  // outgoing requests reserve friend slots so that an accepted request can never exceed the limit
  if (s.friends.ids.length + s.friends.outgoing.length >= maxFriends) throw new AppError('FRIEND_LIMIT');
  if (s.friends.outgoing.length >= maxOutgoing) throw new AppError('FRIEND_LIMIT', 'too many pending requests');
  s.friends.outgoing.push({ to: toId, at: now });
  return 'sent';
}

/** Receiver side of a new request. */
export function friendReceive(m: Master, s: PlayerState, fromId: string, now: number): 'received' | 'already' {
  if (fromId === s.id) throw new AppError('BAD_REQUEST');
  if (isFriend(s, fromId) || s.friends.incoming.some((x) => x.from === fromId)) return 'already';
  if (s.friends.incoming.length >= m.progression.social.maxIncoming) throw new AppError('FRIEND_LIMIT', 'their inbox is full');
  s.friends.incoming.push({ from: fromId, at: now });
  return 'received';
}

/** Receiver accepts: requires a pending incoming request. */
export function friendAccept(m: Master, s: PlayerState, fromId: string): 'accepted' | 'already_friends' {
  if (isFriend(s, fromId)) return 'already_friends';
  if (!s.friends.incoming.some((x) => x.from === fromId)) throw new AppError('NOT_FOUND', 'no such request');
  if (s.friends.ids.length >= m.progression.social.maxFriends) throw new AppError('FRIEND_LIMIT');
  addFriend(s, fromId);
  return 'accepted';
}

/** Sender learns the request was accepted (its outgoing slot was reserved, so no limit check). */
export function friendAccepted(s: PlayerState, byId: string) {
  addFriend(s, byId);
  return { ok: true };
}

export function friendDecline(s: PlayerState, fromId: string) { dropIncoming(s, fromId); return { ok: true }; }
export function friendCancel(s: PlayerState, toId: string) { dropOutgoing(s, toId); return { ok: true }; }
export function friendRemove(s: PlayerState, otherId: string) {
  s.friends.ids = s.friends.ids.filter((x) => x !== otherId);
  dropIncoming(s, otherId);
  dropOutgoing(s, otherId);
  return { ok: true };
}

/** REQ-SOCIAL-005: friend room invitation (receiver side). Only friends may invite; expired ones are pruned. */
export function receiveInvite(m: Master, s: PlayerState, fromId: string, passphrase: string, now: number) {
  if (!isFriend(s, fromId)) throw new AppError('NOT_ELIGIBLE', 'not friends');
  pruneInvites(m, s, now);
  s.friends.invites = s.friends.invites.filter((x) => !(x.from === fromId && x.passphrase === passphrase));
  s.friends.invites.push({ from: fromId, passphrase, at: now });
  const max = m.progression.social.maxInvites;
  if (s.friends.invites.length > max) s.friends.invites.splice(0, s.friends.invites.length - max);
  return { ok: true };
}

export function pruneInvites(m: Master, s: PlayerState, now: number) {
  s.friends.invites = s.friends.invites.filter((x) => now - x.at < m.progression.social.inviteTtlMs);
  return s.friends.invites;
}

// ---- cross-player orchestration ----

/** Profile/code directory (DirectoryDO shards in production, MemoryDirectory in tests). */
export interface Directory {
  /** Returns the player's friend code, assigning one on first call. */
  codeOf(playerId: string): Promise<string>;
  lookup(code: string): Promise<string | null>;
  putProfile(p: PublicProfile): Promise<void>;
  profiles(ids: string[]): Promise<PublicProfile[]>;
}

/** Subset of PlayerService calls the orchestration needs (Durable Object RPC in production). */
export interface FriendPlayers {
  send(uid: string, toId: string): Promise<SendOutcome>;
  receive(uid: string, fromId: string): Promise<'received' | 'already'>;
  accept(uid: string, fromId: string): Promise<'accepted' | 'already_friends'>;
  accepted(uid: string, byId: string): Promise<unknown>;
  decline(uid: string, fromId: string): Promise<unknown>;
  cancel(uid: string, toId: string): Promise<unknown>;
  remove(uid: string, otherId: string): Promise<unknown>;
  invite(uid: string, fromId: string, passphrase: string): Promise<unknown>;
  friendsState(uid: string): Promise<{ ids: string[]; incoming: { from: string; at: number }[]; outgoing: { to: string; at: number }[]; invites: { from: string; passphrase: string; at: number }[] }>;
}

export class FriendsService {
  constructor(private readonly players: FriendPlayers, private readonly dir: Directory) {}

  myCode(uid: string) { return this.dir.codeOf(uid).then((code) => ({ code })); }

  /** REQ-SOCIAL-002: request by friend code. Sender step first (limits), then receiver; compensates on failure. */
  async request(uid: string, code: string) {
    const target = await this.dir.lookup(code);
    if (!target) throw new AppError('NOT_FOUND', 'unknown friend code');
    if (target === uid) throw new AppError('BAD_REQUEST', 'cannot befriend yourself');
    const out = await this.players.send(uid, target);
    if (out === 'mutual') {
      await this.players.accepted(target, uid);
      return { status: 'friends' as const, playerId: target };
    }
    if (out === 'already_friends') return { status: 'friends' as const, playerId: target };
    try {
      await this.players.receive(target, uid);
    } catch (e) {
      if (out === 'sent') await this.players.cancel(uid, target);
      throw e;
    }
    return { status: 'requested' as const, playerId: target };
  }

  async accept(uid: string, fromId: string) {
    await this.players.accept(uid, fromId);
    await this.players.accepted(fromId, uid);
    return { status: 'friends' as const, playerId: fromId };
  }

  async decline(uid: string, fromId: string) {
    await this.players.decline(uid, fromId);
    await this.players.cancel(fromId, uid);
    return { ok: true };
  }

  async cancel(uid: string, toId: string) {
    await this.players.cancel(uid, toId);
    await this.players.decline(toId, uid);
    return { ok: true };
  }

  async remove(uid: string, otherId: string) {
    await this.players.remove(uid, otherId);
    await this.players.remove(otherId, uid);
    return { ok: true };
  }

  /** REQ-SOCIAL-004: friends with their public profiles (last seen, class, rating, record). */
  async list(uid: string) {
    const st = await this.players.friendsState(uid);
    const profiles = await this.dir.profiles([...st.ids, ...st.incoming.map((x) => x.from), ...st.outgoing.map((x) => x.to)]);
    const byId = new Map(profiles.map((p) => [p.playerId, p]));
    const view = (id: string) => byId.get(id) ?? { playerId: id, displayName: '???', titleId: null, classId: 'C', rating: 0, stats: { races: 0, wins: 0, top3: 0 }, lastSeenAt: 0 };
    return {
      friends: st.ids.map(view),
      incoming: st.incoming.map((x) => ({ ...view(x.from), requestedAt: x.at })),
      outgoing: st.outgoing.map((x) => ({ ...view(x.to), requestedAt: x.at })),
      invites: st.invites.map((x) => ({ from: view(x.from), passphrase: x.passphrase, at: x.at })),
    };
  }

  /** REQ-SOCIAL-005: invite a friend to a friend room (sender must be a member of that room — checked by the caller). */
  async invite(uid: string, friendId: string, passphrase: string) {
    const st = await this.players.friendsState(uid);
    if (!st.ids.includes(friendId)) throw new AppError('NOT_ELIGIBLE', 'not friends');
    await this.players.invite(friendId, uid, passphrase);
    return { ok: true };
  }
}

/** In-memory directory used by tests and local tools. */
export class MemoryDirectory implements Directory {
  private codes = new Map<string, string>();
  private byCode = new Map<string, string>();
  private seq = new Map<number, number>();
  private prof = new Map<string, PublicProfile>();
  async codeOf(playerId: string) {
    let c = this.codes.get(playerId);
    if (!c) {
      const shard = shardOf(playerId);
      const n = this.seq.get(shard) ?? 0;
      this.seq.set(shard, n + 1);
      c = friendCode(shard, n);
      this.codes.set(playerId, c);
      this.byCode.set(c, playerId);
    }
    return c;
  }
  async lookup(code: string) { return this.byCode.get(code) ?? null; }
  async putProfile(p: PublicProfile) { this.prof.set(p.playerId, p); }
  async profiles(ids: string[]) { return ids.map((id) => this.prof.get(id)).filter((x): x is PublicProfile => !!x); }
}
