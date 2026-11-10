/**
 * おすすめフレンド (friend suggestions) — REQ-FSUG-001..016, contracts/protocol.md §49.
 *
 * Suggests people the player has already met in the game (friend-room / event / tournament opponents, branch members,
 * players who liked their stable or cheered their race) plus a count of mutual friends. Nothing is granted (no E number).
 * Requests go through the existing friend request flow (FriendsService.requestTo → friendSend / friendReceive), so the
 * friend limits, the activity entries (§40) and the pushes apply unchanged.
 *
 * Privacy: ranked opponents are never used; a player who turned on 「おすすめに表示しない」, a registered under-13, a banned or
 * deleting account has no card in the directory and so is never suggested nor used as a mutual-friend bridge; blocks are
 * checked both ways (the one block list, teamFeed.muted). Mutual friends are only ever a count.
 *
 * Pure state logic + a small orchestration service (FriendSuggestService) over ports, like friends.ts.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { moderationOf } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import type { PublicProfile } from './stats.js';
import { DIRECTORY_SHARDS, shardOf } from './friends.js';

export const FSUG_KINDS = ['opponent', 'team', 'liked', 'cheered', 'mutual'] as const;
export type FsugKind = typeof FSUG_KINDS[number];
/** Modes whose confirmed human field may be suggested (REQ-FSUG-013). Ranked is deliberately absent (§49.1). */
export const FSUG_RACE_MODES = ['friend', 'event', 'tournament', 'cup'] as const; // cup: hosted cup mates (Round 17 integration, §42)

export interface FsugConfig {
  enabled: boolean; maxShown: number; candidateMax: number; fofFriendsMax: number; fofMin: number; mutualCap: number;
  opponentDays: number; opponentKeep: number; dismissKeep: number; cacheTtlMs: number; minAgeShown: number;
  weights: Record<FsugKind, number>;
}
export const FSUG_DEFAULTS: FsugConfig = {
  enabled: true, maxShown: 10, candidateMax: 60, fofFriendsMax: 20, fofMin: 2, mutualCap: 5,
  opponentDays: 30, opponentKeep: 50, dismissKeep: 200, cacheTtlMs: 300_000, minAgeShown: 13,
  weights: { opponent: 40, team: 30, liked: 25, cheered: 25, mutual: 10 },
};
const LIMITS: Record<Exclude<keyof FsugConfig, 'enabled' | 'weights'>, [number, number]> = {
  maxShown: [1, 30], candidateMax: [10, 200], fofFriendsMax: [0, 50], fofMin: [1, 10], mutualCap: [1, 20],
  opponentDays: [1, 90], opponentKeep: [10, 200], dismissKeep: [10, 1000], cacheTtlMs: [0, 3_600_000], minAgeShown: [0, 18],
};
/** Team members read per request (a team is at most `teams.maxMembers`, 20 today). */
export const FSUG_TEAM_MAX = 50;
/** Players whose computed list a worker keeps (REQ-FSUG-010). */
export const FSUG_CACHE_MAX = 1000;

type MasterLike = Pick<Master, 'progression'>;
const rawOf = (m: MasterLike) => (m.progression as { friendSuggest?: Partial<FsugConfig> }).friendSuggest;

export function fsugConfig(m: MasterLike): FsugConfig {
  const raw = Object.fromEntries(Object.entries(rawOf(m) ?? {}).filter(([k]) => !k.startsWith('_'))) as Partial<FsugConfig>;
  return { ...FSUG_DEFAULTS, ...raw, weights: { ...FSUG_DEFAULTS.weights, ...(raw.weights ?? {}) } };
}

/** REQ-FSUG-012: boot and remote-config validation. */
export function fsugProblems(m: MasterLike, path = 'progression.friendSuggest'): string[] {
  const raw = rawOf(m);
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object') return [`${path} must be an object`];
  const out: string[] = [];
  const known = Object.keys(FSUG_DEFAULTS);
  for (const k of Object.keys(raw)) if (!known.includes(k) && !k.startsWith('_')) out.push(`${path}.${k} is unknown`);
  const c = fsugConfig(m);
  if (typeof c.enabled !== 'boolean') out.push(`${path}.enabled must be a boolean`);
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = c[k as keyof typeof LIMITS];
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${path}.${k} must be an integer ${lo}..${hi}`);
  }
  if (Number.isInteger(c.candidateMax) && Number.isInteger(c.maxShown) && c.candidateMax < c.maxShown) out.push(`${path}.candidateMax must be at least maxShown`);
  if (!c.weights || typeof c.weights !== 'object') out.push(`${path}.weights must be an object`);
  else {
    for (const k of Object.keys(c.weights)) if (!(FSUG_KINDS as readonly string[]).includes(k)) out.push(`${path}.weights.${k} is unknown`);
    for (const k of FSUG_KINDS) {
      const v = c.weights[k];
      if (!Number.isInteger(v) || v < 0 || v > 100) out.push(`${path}.weights.${k} must be an integer 0..100`);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ player state

export interface FsugDismissed { id: string; at: number; why: 'dismiss' | 'requested' }
export interface FsugOpponent { id: string; at: number; mode: string; n: number }
export interface FsugState { hidden: boolean; dismissed: FsugDismissed[]; opponents: FsugOpponent[]; cardKey?: string }

const peek = (s: PlayerState): FsugState | undefined => s.friendSuggest;
export function ensureFsug(s: PlayerState): FsugState {
  s.friendSuggest ??= { hidden: false, dismissed: [], opponents: [] };
  return s.friendSuggest;
}
/** The one block list (team-feed mute, REQ-RIVAL-011). */
const blockedOf = (s: PlayerState): string[] => (s as PlayerState & { teamFeed?: { muted?: string[] } }).teamFeed?.muted ?? [];
const DAY = 86_400_000;
const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
export const fsugIdOk = (id: string) => ID_RE.test(id);

/** REQ-FSUG-013: remember the human field of a confirmed friend-room / event / tournament race. */
export function noteFsugRace(m: MasterLike, s: PlayerState, r: { mode: string; void: boolean; field?: { playerId: string }[] }, now: number) {
  if (r.void || !(FSUG_RACE_MODES as readonly string[]).includes(r.mode)) return;
  const others = [...new Set((r.field ?? []).map((f) => f.playerId).filter((id) => id && id !== s.id))];
  if (others.length === 0) return;
  const c = fsugConfig(m);
  const st = ensureFsug(s);
  for (const id of others) {
    const prev = st.opponents.find((x) => x.id === id);
    st.opponents = [...st.opponents.filter((x) => x.id !== id), { id, at: now, mode: r.mode, n: (prev?.n ?? 0) + 1 }];
  }
  st.opponents = st.opponents.filter((x) => now - x.at < c.opponentDays * DAY);
  if (st.opponents.length > c.opponentKeep) st.opponents.splice(0, st.opponents.length - c.opponentKeep);
}

/** REQ-FSUG-009 / 008: remember a dismissed (or requested) suggestion; true when the record changed (new, or dismiss → requested). */
export function fsugDismiss(m: MasterLike, s: PlayerState, id: string, why: FsugDismissed['why'], now: number): boolean {
  if (id === s.id) throw new AppError('BAD_REQUEST', 'cannot dismiss yourself');
  if (!fsugIdOk(id)) throw new AppError('BAD_REQUEST', 'bad player id');
  const st = ensureFsug(s);
  const prev = st.dismissed.find((x) => x.id === id);
  if (prev && (prev.why === why || prev.why === 'requested')) return false;
  st.dismissed = [...st.dismissed.filter((x) => x.id !== id), { id, at: now, why }];
  const keep = fsugConfig(m).dismissKeep;
  if (st.dismissed.length > keep) st.dismissed.splice(0, st.dismissed.length - keep);
  return true;
}

/** REQ-FSUG-007: 「おすすめに表示しない」. */
export function fsugSetHidden(s: PlayerState, hidden: boolean) {
  ensureFsug(s).hidden = hidden;
  return { hidden };
}

/** Age in whole years from the registered birth year/month (JST month). Null = not registered. */
function ageOf(s: PlayerState, now: number): number | null {
  if (!s.age) return null;
  const d = new Date(now + 9 * 3_600_000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  return y - s.age.birthYear - (mo < s.age.birthMonth ? 1 : 0);
}

/** What the directory keeps about a suggestable player (never returned to other players). */
export interface FsugCard { playerId: string; blocked: string[]; friends: string[]; updatedAt: number }

/**
 * REQ-FSUG-011: the card, or null when the player must never be suggested nor used as a mutual-friend bridge
 * (opted out, registered under minAgeShown, banned, deletion scheduled or running).
 */
export function fsugCard(m: MasterLike, s: PlayerState, now: number): FsugCard | null {
  if (peek(s)?.hidden) return null;
  if (deletionScheduled(s)) return null;
  if (moderationOf(s, now) === 'banned') return null;
  const age = ageOf(s, now);
  if (age !== null && age < fsugConfig(m).minAgeShown) return null;
  return { playerId: s.id, blocked: [...blockedOf(s)].sort(), friends: [...s.friends.ids].sort(), updatedAt: now };
}
export const fsugCardKey = (c: FsugCard | null) => (c ? JSON.stringify([c.blocked, c.friends]) : 'null');

/** A timed signal from the player's own state. */
export interface FsugSignal { id: string; at: number; n: number }
/** Everything the computation needs from the player's own state (one read of the PlayerDO). */
export interface FsugSelf {
  playerId: string; enabled: boolean; deleting: boolean; hidden: boolean; teamId: string | null;
  friends: string[]; pending: string[]; blocked: string[]; dismissed: string[];
  /** Asked through a suggestion (a subset of dismissed): a retried request answers without sending again. */
  requested: string[];
  opponents: FsugSignal[]; likers: FsugSignal[]; cheerers: FsugSignal[];
}

/** Senders of an activity kind still in the list (already shown to the player by name, §40). */
function activityActors(s: PlayerState, kind: string): FsugSignal[] {
  const entries = (s as PlayerState & { activity?: { entries: { kind: string; at: number; actors: { id: string; n: number }[] }[] } }).activity?.entries ?? [];
  const by = new Map<string, FsugSignal>();
  for (const e of entries) {
    if (e.kind !== kind) continue;
    for (const a of e.actors) {
      const p = by.get(a.id);
      by.set(a.id, { id: a.id, at: Math.max(p?.at ?? 0, e.at), n: (p?.n ?? 0) + a.n });
    }
  }
  return [...by.values()];
}

export function fsugSelf(m: MasterLike, s: PlayerState, now: number): FsugSelf {
  const c = fsugConfig(m);
  const st = peek(s);
  return {
    playerId: s.id, enabled: c.enabled, deleting: deletionScheduled(s), hidden: st?.hidden ?? false, teamId: s.team?.teamId ?? null,
    friends: [...s.friends.ids], pending: [...s.friends.incoming.map((x) => x.from), ...s.friends.outgoing.map((x) => x.to)],
    blocked: [...blockedOf(s)], dismissed: (st?.dismissed ?? []).map((x) => x.id), requested: (st?.dismissed ?? []).filter((x) => x.why === 'requested').map((x) => x.id),
    opponents: (st?.opponents ?? []).filter((x) => now - x.at < c.opponentDays * DAY).map((x) => ({ id: x.id, at: x.at, n: x.n })),
    likers: activityActors(s, 'stable_like'), cheerers: activityActors(s, 'team_cheer'),
  };
}

// ------------------------------------------------------------------------------------------------ ranking (pure)

export interface FsugReason { kind: FsugKind; n?: number }
interface Scored { id: string; score: number; latest: number; reasons: { kind: FsugKind; n?: number; pts: number }[] }

/** Ids the player may never be shown (REQ-FSUG-004/005), from fresh own state. */
const excludedBy = (self: FsugSelf) => new Set([self.playerId, ...self.friends, ...self.pending, ...self.blocked, ...self.dismissed]);

/**
 * REQ-FSUG-001/002/010: candidates from the own signals and the friends' cards, scored and capped at candidateMax.
 * `friendCards` are cards of (at most fofFriendsMax of) the player's friends; a friend without a card is no bridge.
 */
export function fsugCandidates(m: MasterLike, self: FsugSelf, teamMembers: string[], friendCards: FsugCard[]): Scored[] {
  const c = fsugConfig(m);
  const w = c.weights;
  const out = excludedBy(self);
  const acc = new Map<string, Scored>();
  const add = (id: string, kind: FsugKind, pts: number, at: number, n?: number) => {
    if (out.has(id) || pts <= 0) return;
    const x = acc.get(id) ?? { id, score: 0, latest: 0, reasons: [] };
    x.score += pts;
    x.latest = Math.max(x.latest, at);
    x.reasons.push({ kind, pts, ...(n !== undefined ? { n } : {}) });
    acc.set(id, x);
  };
  for (const o of self.opponents) add(o.id, 'opponent', w.opponent, o.at);
  for (const id of teamMembers.slice(0, FSUG_TEAM_MAX)) add(id, 'team', w.team, 0);
  for (const l of self.likers) add(l.id, 'liked', w.liked, l.at);
  for (const ch of self.cheerers) add(ch.id, 'cheered', w.cheered, ch.at);
  const friends = new Set(self.friends);
  const mutual = new Map<string, number>();
  for (const card of friendCards) {
    if (!friends.has(card.playerId)) continue;
    // a friend who blocked me is no bridge to their friends
    if (card.blocked.includes(self.playerId)) continue;
    for (const f of card.friends) mutual.set(f, (mutual.get(f) ?? 0) + 1);
  }
  for (const [id, n] of mutual) if (n >= c.fofMin) add(id, 'mutual', w.mutual * Math.min(n, c.mutualCap), 0, n);
  return sortScored([...acc.values()]).slice(0, c.candidateMax);
}

const KIND_ORDER = new Map(FSUG_KINDS.map((k, i) => [k, i]));
const sortScored = (xs: Scored[]) => xs.sort((a, b) => b.score - a.score || b.latest - a.latest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A row of the list before own-state filtering (what the cache keeps). */
export interface FsugRow {
  playerId: string; displayName: string; titleId: string | null; classId: string; silks?: PublicProfile['silks'];
  reasons: FsugReason[]; score: number;
}

/**
 * REQ-FSUG-005/006/007: drop candidates without a card (hidden, under age, banned, deleting, inactive since the card
 * existed), who blocked me, who already count me as a friend, and without a live unbanned public profile.
 */
export function fsugRows(self: FsugSelf, scored: Scored[], cards: { card: FsugCard; profile: PublicProfile | null }[]): FsugRow[] {
  const byId = new Map(cards.map((x) => [x.card.playerId, x]));
  const rows: FsugRow[] = [];
  for (const sc of scored) {
    const x = byId.get(sc.id);
    if (!x || !x.profile || x.profile.banned) continue;
    if (x.card.blocked.includes(self.playerId) || x.card.friends.includes(self.playerId)) continue;
    const reasons = [...sc.reasons].sort((a, b) => b.pts - a.pts || KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!).slice(0, 2)
      .map((r) => (r.n !== undefined ? { kind: r.kind, n: r.n } : { kind: r.kind }));
    const p = x.profile;
    rows.push({ playerId: sc.id, displayName: p.displayName, titleId: p.titleId, classId: p.classId, ...(p.silks ? { silks: p.silks } : {}), reasons, score: sc.score });
  }
  return rows;
}

/** Own-state filter applied on every read, cached or not (REQ-FSUG-010). */
export const fsugFilter = (self: FsugSelf, rows: FsugRow[]) => { const out = excludedBy(self); return rows.filter((r) => !out.has(r.playerId)); };

// ------------------------------------------------------------------------------------------------ texts (REQ-FSUG-003/015)

/** Japanese; the English is in i18n/en.ts (applied at the response boundary, §23). */
export const FSUG_TEXT = {
  opponent: '最近のレースで対戦',
  team: '同じ支部',
  liked: 'マイ厩舎にいいねをくれた',
  cheered: '応援スタンプをくれた',
  mutual: '共通のフレンド{n}人',
} as const;
export const FSUG_JOIN = '・';
export const fsugText = (reasons: FsugReason[]) => reasons.map((r) => FSUG_TEXT[r.kind].replace('{n}', String(r.n ?? 0))).join(FSUG_JOIN);

// ------------------------------------------------------------------------------------------------ orchestration

/** Card store (DirectoryDO shards in production, MemorySuggestDirectory in tests). */
export interface SuggestDirectory {
  put(card: FsugCard): Promise<void>;
  remove(playerId: string): Promise<void>;
  /** Cards that exist, each with the public profile of the same player (null = none). */
  cards(ids: string[]): Promise<{ card: FsugCard; profile: PublicProfile | null }[]>;
}

export interface SuggestPlayers {
  self(uid: string): Promise<FsugSelf>;
  /** Member ids of the team if the player is in it, else []. */
  teamMembers(teamId: string, uid: string): Promise<string[]>;
  dismiss(uid: string, target: string, why: FsugDismissed['why'], reason: FsugKind | 'none', outcome?: 'requested' | 'friends'): Promise<unknown>;
  setHidden(uid: string, hidden: boolean): Promise<{ hidden: boolean }>;
}

export interface SuggestFriends {
  /** The existing friend request flow (REQ-SOCIAL-002), by player id. */
  requestTo(uid: string, target: string): Promise<{ status: 'requested' | 'friends'; playerId: string }>;
}

export type FsugCache = Map<string, { at: number; rows: FsugRow[] }>;
/** Per isolate (the request context is rebuilt per request); bounded at FSUG_CACHE_MAX players, oldest out first. */
const ISOLATE_CACHE: FsugCache = new Map();

export class FriendSuggestService {
  constructor(
    private readonly players: SuggestPlayers, private readonly friends: SuggestFriends, private readonly dir: SuggestDirectory,
    private readonly cfg: () => FsugConfig, private readonly clock: () => number = Date.now, private readonly cache: FsugCache = ISOLATE_CACHE,
  ) {}

  /** The bounded fan-out (REQ-FSUG-010): team 1, friends' cards ≤ fofFriendsMax, candidates ≤ candidateMax. */
  private async compute(self: FsugSelf): Promise<FsugRow[]> {
    const c = this.cfg();
    const m = { progression: { friendSuggest: c } } as unknown as MasterLike;
    let team: string[] = [];
    if (self.teamId) { try { team = await this.players.teamMembers(self.teamId, self.playerId); } catch { team = []; } }
    // the most recently added friends (insertion order) bridge to their friends
    const bridges = c.fofFriendsMax > 0 ? self.friends.slice(-c.fofFriendsMax) : [];
    const friendCards = bridges.length ? (await this.dir.cards(bridges)).map((x) => x.card) : [];
    const scored = fsugCandidates(m, self, team, friendCards);
    if (scored.length === 0) return [];
    const cards = await this.dir.cards(scored.map((x) => x.id));
    return fsugRows(self, scored, cards);
  }

  private remember(uid: string, rows: FsugRow[], now: number) {
    this.cache.delete(uid);
    this.cache.set(uid, { at: now, rows });
    while (this.cache.size > FSUG_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }

  /** REQ-FSUG-001: the list (own-state exclusions applied fresh on every read). */
  async list(uid: string) {
    const self = await this.players.self(uid);
    const c = this.cfg();
    const settings = { hidden: self.hidden };
    if (!self.enabled || !c.enabled) return { enabled: false as const, items: [], settings };
    if (self.deleting) return { enabled: true as const, items: [], settings };
    const now = this.clock();
    const hit = this.cache.get(uid);
    let rows: FsugRow[];
    if (hit && c.cacheTtlMs > 0 && now - hit.at < c.cacheTtlMs) rows = hit.rows;
    else { rows = await this.compute(self); if (c.cacheTtlMs > 0) this.remember(uid, rows, now); }
    const items = fsugFilter(self, rows).slice(0, c.maxShown).map(({ score: _s, ...r }) => ({ ...r, text: fsugText(r.reasons) }));
    return { enabled: true as const, items, settings };
  }

  /** REQ-FSUG-008: only someone suggestable right now (checked without the cache); anyone else is NOT_FOUND. */
  async request(uid: string, target: string) {
    if (!fsugIdOk(target) || target === uid) throw new AppError('NOT_FOUND', 'no such suggestion');
    const self = await this.players.self(uid);
    if (!self.enabled || !this.cfg().enabled || self.deleting) throw new AppError('NOT_FOUND', 'no such suggestion');
    // a retry of a request that went through: the same answer, nothing sent again (whatever the other side did since)
    if (self.requested.includes(target)) return { status: self.friends.includes(target) ? 'friends' as const : 'requested' as const, playerId: target };
    const rows = fsugFilter(self, await this.compute(self));
    const row = rows.find((r) => r.playerId === target);
    if (!row) throw new AppError('NOT_FOUND', 'no such suggestion');
    const out = await this.friends.requestTo(uid, target);
    await this.players.dismiss(uid, target, 'requested', row.reasons[0]?.kind ?? 'none', out.status);
    this.cache.delete(uid);
    return out;
  }

  /** REQ-FSUG-009: idempotent. */
  async dismiss(uid: string, target: string) {
    if (!fsugIdOk(target)) throw new AppError('BAD_REQUEST', 'bad player id');
    const reason = this.cache.get(uid)?.rows.find((r) => r.playerId === target)?.reasons[0]?.kind ?? 'none';
    await this.players.dismiss(uid, target, 'dismiss', reason);
    return { ok: true as const };
  }

  setHidden(uid: string, hidden: boolean) { return this.players.setHidden(uid, hidden); }
}

/** In-memory card store for tests and local tools; profiles come from the given directory. */
export class MemorySuggestDirectory implements SuggestDirectory {
  readonly store = new Map<string, FsugCard>();
  constructor(private readonly profiles: { profiles(ids: string[]): Promise<PublicProfile[]> }) {}
  async put(card: FsugCard) { this.store.set(card.playerId, card); }
  async remove(id: string) { this.store.delete(id); }
  async cards(ids: string[]) {
    const found = ids.map((id) => this.store.get(id)).filter((x): x is FsugCard => !!x);
    const prof = new Map((await this.profiles.profiles(found.map((x) => x.playerId))).map((p) => [p.playerId, p]));
    return found.map((card) => ({ card, profile: prof.get(card.playerId) ?? null }));
  }
}

/** Groups ids by directory shard (at most DIRECTORY_SHARDS calls per lookup). */
export function byShard(ids: string[]): Map<number, string[]> {
  const g = new Map<number, string[]>();
  for (const id of new Set(ids)) { const s = shardOf(id); g.set(s, [...(g.get(s) ?? []), id]); }
  return g;
}
export { DIRECTORY_SHARDS };
