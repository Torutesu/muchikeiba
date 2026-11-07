/**
 * 支部の応援スタンプ（REQ-TEAMFEED-*）: a team feed made only of fixed stamps and automatic race items, so there is no
 * free text to moderate (docs/planning/03: no user-written text reaches other players besides the NG-checked names).
 *
 * - Stamps are master data (`master/stamps.json`): id, label, asset key `stamp/<id>` and how they unlock — free,
 *   by play (lifetime races), by owning a season pass once, or by a cosmetic bought directly for coins (a fixed price,
 *   no randomness: never from gacha).
 * - The TEAM object keeps the feed: a ring buffer of the last `feedSize` items, the per-member post rate limit, reactions
 *   and reports. The PLAYER object keeps what is personal: which stamps are unlocked, the mute list, the teams the player
 *   posted in (so an account deletion can remove their items everywhere) and the KPI rows.
 * - Mute ("block") is per viewer: the muted member's items and reactions disappear from the viewer's feed and their
 *   reactions never notify the viewer. The client applies it locally at once and stores it on the server.
 * - Report flags the item for support (a support flag on the reported player) and hides it for the reporter.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { dayRule, gameDayKey } from './time.js';
import stampsJson from '../../master/stamps.json';

export type StampUnlock = { kind: 'default' } | { kind: 'races'; count: number } | { kind: 'pass' } | { kind: 'cosmetic'; itemId: string };
export interface StampDef { id: string; label: string; unlock: StampUnlock }
export interface StampsConfig {
  /** Minimum time between two posts of one member (ms). */
  postIntervalMs: number;
  /** Posts per member and game day. */
  postsPerDay: number;
  /** Ring buffer size per team. */
  feedSize: number;
  pageDefault: number;
  pageMax: number;
  /** Reports one member may file per game day. */
  reportsPerDay: number;
  /** Size of a player's mute list. */
  muteMax: number;
  /** A race result becomes a feed item when the place is at most this (ranked and tournament races). */
  racePlaceMax: number;
}
export interface StampsMaster { version: number; config: StampsConfig; stamps: StampDef[] }

export const STAMP_ID_RE = /^[a-z0-9_]{1,32}$/;
export const REPORT_REASONS = ['spam', 'harassment', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];
export const FEED_RACE_MODES = ['ranked', 'tournament'] as const;
export const stampAsset = (id: string) => `stamp/${id}`;

export function stampsOf(m: Master): StampsMaster {
  return m.stamps ?? (stampsJson as unknown as StampsMaster);
}

export function findStamp(m: Master, id: string): StampDef {
  const d = stampsOf(m).stamps.find((x) => x.id === id);
  if (!d) throw new AppError('NOT_FOUND', `stamp ${id}`);
  return d;
}

/** Consistency of master/stamps.json against the cosmetics (checked at boot of tests and by remote config). */
export function stampsProblems(m: Master): string[] {
  const sm = stampsOf(m);
  const p: string[] = [];
  const c = sm.config;
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!intIn(c.postIntervalMs, 1000, 3_600_000)) p.push('stamps.config.postIntervalMs must be 1s..1h');
  if (!intIn(c.postsPerDay, 1, 500)) p.push('stamps.config.postsPerDay must be 1..500');
  if (!intIn(c.feedSize, 10, 500)) p.push('stamps.config.feedSize must be 10..500');
  if (!intIn(c.pageMax, 1, c.feedSize) || !intIn(c.pageDefault, 1, c.pageMax)) p.push('stamps.config.pageDefault <= pageMax <= feedSize');
  if (!intIn(c.reportsPerDay, 1, 100)) p.push('stamps.config.reportsPerDay must be 1..100');
  if (!intIn(c.muteMax, 1, 1000)) p.push('stamps.config.muteMax must be 1..1000');
  if (!intIn(c.racePlaceMax, 1, 3)) p.push('stamps.config.racePlaceMax must be 1..3');
  const ids = new Set<string>();
  for (const s of sm.stamps) {
    if (!STAMP_ID_RE.test(s.id)) p.push(`stamp ${s.id}: bad id`);
    if (ids.has(s.id)) p.push(`stamp ${s.id}: duplicate`);
    ids.add(s.id);
    const len = [...(s.label ?? '')].length;
    if (len < 1 || len > 12) p.push(`stamp ${s.id}: label must be 1..12 characters`);
    const u = s.unlock;
    if (u.kind === 'races') { if (!intIn(u.count, 1, 100_000)) p.push(`stamp ${s.id}: races.count must be 1..100000`); }
    else if (u.kind === 'cosmetic') {
      const cos = m.items.cosmetics.find((x) => x.id === u.itemId);
      if (!cos) p.push(`stamp ${s.id}: unknown cosmetic ${u.itemId}`);
      else if (cos.kind !== 'stamp' || cos.asset !== stampAsset(s.id)) p.push(`stamp ${s.id}: cosmetic ${u.itemId} must be kind "stamp" with asset ${stampAsset(s.id)}`);
      else if (cos.notForSale) p.push(`stamp ${s.id}: cosmetic ${u.itemId} must be sold directly`);
    } else if (u.kind !== 'default' && u.kind !== 'pass') p.push(`stamp ${s.id}: unknown unlock kind`);
  }
  if (!sm.stamps.some((s) => s.unlock.kind === 'default')) p.push('stamps: at least one stamp must be free (unlock default)');
  // every stamp cosmetic unlocks exactly one stamp
  for (const cos of m.items.cosmetics) {
    if (cos.kind !== 'stamp') continue;
    const n = sm.stamps.filter((s) => s.unlock.kind === 'cosmetic' && s.unlock.itemId === cos.id).length;
    if (n !== 1) p.push(`cosmetic ${cos.id}: unlocks ${n} stamps (expected 1)`);
  }
  return p;
}

const everHadPass = (s: PlayerState) => s.purchases.some((x) => !x.refunded && x.passSeasonId !== undefined);

/** REQ-TEAMFEED-002: is this stamp usable by the player. */
export function stampUnlocked(s: PlayerState, d: StampDef): boolean {
  const u = d.unlock;
  switch (u.kind) {
    case 'default': return true;
    case 'races': return s.stats.races >= u.count;
    case 'pass': return everHadPass(s);
    case 'cosmetic': return (s.items[u.itemId] ?? 0) > 0;
  }
}

/** What the lock says (server-built, like every product text). */
export function unlockText(m: Master, d: StampDef): string {
  const u = d.unlock;
  switch (u.kind) {
    case 'default': return '最初から使える';
    case 'races': return `レースに${u.count}回出走で解放`;
    case 'pass': return 'シーズンパスの購入で解放（一度買えばずっと使える）';
    case 'cosmetic': {
      const c = m.items.cosmetics.find((x) => x.id === u.itemId);
      return c ? `見た目ショップで購入（${c.price}コイン${c.currency === 'paidOnly' ? '・有償限定' : ''}）` : '見た目ショップで購入';
    }
  }
}

/** REQ-TEAMFEED-001: GET /v1/stamps — the stamp set with this player's unlocks. */
export function stampCatalog(m: Master, s: PlayerState) {
  const sm = stampsOf(m);
  return {
    version: sm.version,
    limits: { postIntervalMs: sm.config.postIntervalMs, postsPerDay: sm.config.postsPerDay, feedSize: sm.config.feedSize, pageMax: sm.config.pageMax },
    stamps: sm.stamps.map((d) => ({
      id: d.id, label: d.label, asset: stampAsset(d.id),
      unlock: { kind: d.unlock.kind, ...(d.unlock.kind === 'races' ? { count: d.unlock.count } : {}), ...(d.unlock.kind === 'cosmetic' ? { itemId: d.unlock.itemId } : {}) },
      unlockText: unlockText(m, d),
      unlocked: stampUnlocked(s, d),
    })),
  };
}

// ------------------------------------------------------------------------------------- player side

export interface PlayerFeedState {
  /** Members this player muted (blocked) in team feeds. */
  muted: string[];
  /** Teams this player posted or reacted in (most recent last), for the account deletion. */
  postedIn: string[];
}
const POSTED_IN_KEEP = 10;

export function ensureFeed(s: PlayerState): PlayerFeedState {
  const x = s as PlayerState & { teamFeed?: PlayerFeedState };
  x.teamFeed ??= { muted: [], postedIn: [] };
  return x.teamFeed;
}

/**
 * REQ-TEAMFEED-003/008: player-side checks before a post or a reaction — not while the account deletion is scheduled,
 * only as a team member, only an unlocked stamp. Records the team for the deletion (before the team stores anything).
 */
export function playerStampCheck(m: Master, s: PlayerState, stampId: string) {
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const teamId = s.team?.teamId ?? null;
  if (!teamId) throw new AppError('NOT_IN_TEAM');
  const d = findStamp(m, stampId);
  if (!stampUnlocked(s, d)) throw new AppError('STAMP_LOCKED', unlockText(m, d));
  notePostedIn(s, teamId);
  return { teamId, displayName: s.profile.displayName };
}

/** REQ-TEAMFEED-008: remember a team whose feed holds something of this player (stamp, reaction or race item). */
export function notePostedIn(s: PlayerState, teamId: string) {
  const f = ensureFeed(s);
  f.postedIn = [...f.postedIn.filter((t) => t !== teamId), teamId].slice(-POSTED_IN_KEEP);
}

/** REQ-TEAMFEED-006: mute / unmute a member (server copy of the client's local list). */
export function playerMute(m: Master, s: PlayerState, target: string, muted: boolean) {
  if (target === s.id) throw new AppError('BAD_REQUEST', 'cannot mute yourself');
  const f = ensureFeed(s);
  const has = f.muted.includes(target);
  if (muted && !has) {
    if (f.muted.length >= stampsOf(m).config.muteMax) throw new AppError('TEAM_LIMIT', `at most ${stampsOf(m).config.muteMax} muted players`);
    f.muted.push(target);
  }
  if (!muted && has) f.muted = f.muted.filter((x) => x !== target);
  return { muted: [...f.muted] };
}

/** REQ-TEAMFEED-007: a support flag on the reported player (once per item and reporter). */
export function playerReported(s: PlayerState, teamId: string, seq: number, reporter: string, reason: ReportReason) {
  const flag = `team_feed_report:${teamId}:${seq}:${reporter}:${reason}`;
  const flags = (s.supportFlags ??= []);
  const prefix = `team_feed_report:${teamId}:${seq}:${reporter}:`;
  if (flags.some((x) => x.startsWith(prefix))) return { flagged: false };
  flags.push(flag);
  return { flagged: true };
}

// ------------------------------------------------------------------------------------- team side

export interface FeedRace { raceId: string; mode: typeof FEED_RACE_MODES[number]; place: number; fieldSize: number; trackId: string | null }
export interface FeedReaction { playerId: string; stampId: string; at: number }
export interface FeedItem {
  seq: number; at: number; kind: 'stamp' | 'race';
  playerId: string; displayName: string;
  stampId?: string;
  race?: FeedRace;
  reactions: FeedReaction[];
  /** Members who reported this item (hidden for them). */
  reportedBy?: string[];
}
export interface MemberRate { last: number; day: string; posts: number; reportDay: string; reports: number }
export interface TeamFeedState { v: 1; seq: number; items: FeedItem[]; rate: Record<string, MemberRate> }

export const newFeed = (): TeamFeedState => ({ v: 1, seq: 0, items: [], rate: {} });

function rateOf(f: TeamFeedState, playerId: string): MemberRate {
  return (f.rate[playerId] ??= { last: 0, day: '', posts: 0, reportDay: '', reports: 0 });
}

function push(f: TeamFeedState, cfg: StampsConfig, item: Omit<FeedItem, 'seq'>): FeedItem {
  const it: FeedItem = { seq: ++f.seq, ...item };
  f.items.push(it);
  if (f.items.length > cfg.feedSize) f.items.splice(0, f.items.length - cfg.feedSize);
  return it;
}

function itemOf(f: TeamFeedState, seq: number): FeedItem {
  const it = f.items.find((x) => x.seq === seq);
  if (!it) throw new AppError('NOT_FOUND', 'feed item (it may have dropped out of the last items)');
  return it;
}

/** REQ-TEAMFEED-003: a member posts a stamp (1 per postIntervalMs, postsPerDay per game day). */
export function feedPost(m: Master, f: TeamFeedState, member: { playerId: string; displayName: string }, stampId: string, now: number): FeedItem {
  const cfg = stampsOf(m).config;
  findStamp(m, stampId);
  const r = rateOf(f, member.playerId);
  const day = gameDayKey(now, dayRule(m));
  if (r.day !== day) { r.day = day; r.posts = 0; }
  if (now - r.last < cfg.postIntervalMs) throw new AppError('RATE_LIMITED', `one stamp per ${Math.round(cfg.postIntervalMs / 1000)} s`);
  if (r.posts >= cfg.postsPerDay) throw new AppError('RATE_LIMITED', `at most ${cfg.postsPerDay} stamps a day`);
  r.last = now;
  r.posts += 1;
  return push(f, cfg, { at: now, kind: 'stamp', playerId: member.playerId, displayName: member.displayName, stampId, reactions: [] });
}

/** REQ-TEAMFEED-004: automatic item when a member wins or places (once per race and player). */
export function feedRace(m: Master, f: TeamFeedState, member: { playerId: string; displayName: string }, race: FeedRace, now: number): FeedItem | null {
  const cfg = stampsOf(m).config;
  if (!FEED_RACE_MODES.includes(race.mode) || race.place < 1 || race.place > cfg.racePlaceMax) return null;
  if (f.items.some((x) => x.kind === 'race' && x.playerId === member.playerId && x.race?.raceId === race.raceId)) return null;
  return push(f, cfg, { at: now, kind: 'race', playerId: member.playerId, displayName: member.displayName, race, reactions: [] });
}

/**
 * REQ-TEAMFEED-005: one reaction per member and item (a new stamp replaces it, null removes it). Reactions do not count
 * toward the post limit but share the interval (no reaction storms). Returns the item owner and whether this was new.
 */
export function feedReact(m: Master, f: TeamFeedState, seq: number, playerId: string, stampId: string | null, now: number) {
  const cfg = stampsOf(m).config;
  const it = itemOf(f, seq);
  if (stampId !== null) findStamp(m, stampId);
  const r = rateOf(f, playerId);
  if (now - r.last < Math.min(cfg.postIntervalMs, 2000)) throw new AppError('RATE_LIMITED', 'too fast');
  const had = it.reactions.find((x) => x.playerId === playerId);
  it.reactions = it.reactions.filter((x) => x.playerId !== playerId);
  if (stampId !== null) it.reactions.push({ playerId, stampId, at: now });
  r.last = now;
  return { ownerId: it.playerId, isNew: stampId !== null && !had, kind: it.kind };
}

/** REQ-TEAMFEED-007: report an item (reportsPerDay per member and game day). */
export function feedReport(m: Master, f: TeamFeedState, seq: number, reporter: string, now: number) {
  const cfg = stampsOf(m).config;
  const it = itemOf(f, seq);
  if (it.playerId === reporter) throw new AppError('BAD_REQUEST', 'cannot report your own item');
  const by = (it.reportedBy ??= []);
  if (by.includes(reporter)) return { ownerId: it.playerId, first: false };
  const r = rateOf(f, reporter);
  const day = gameDayKey(now, dayRule(m));
  if (r.reportDay !== day) { r.reportDay = day; r.reports = 0; }
  if (r.reports >= cfg.reportsPerDay) throw new AppError('RATE_LIMITED', `at most ${cfg.reportsPerDay} reports a day`);
  r.reports += 1;
  by.push(reporter);
  return { ownerId: it.playerId, first: true };
}

/** REQ-TEAMFEED-008 × REQ-UXS-040: removes a deleted player's items, reactions, reports and rate entry. */
export function feedForget(f: TeamFeedState, playerId: string) {
  const before = f.items.length;
  f.items = f.items.filter((x) => x.playerId !== playerId);
  for (const it of f.items) {
    it.reactions = it.reactions.filter((x) => x.playerId !== playerId);
    if (it.reportedBy) it.reportedBy = it.reportedBy.filter((x) => x !== playerId);
  }
  delete f.rate[playerId];
  return { removed: before - f.items.length };
}

export interface FeedItemView {
  seq: number; at: number; kind: 'stamp' | 'race'; playerId: string; displayName: string; mine: boolean;
  stampId: string | null; stampAsset: string | null; race: FeedRace | null;
  reactions: { stampId: string; count: number; mine: boolean }[];
  myReaction: string | null;
}

/**
 * REQ-TEAMFEED-005/006: a page of the feed for one viewer, newest first. `before` = seq to page down from (exclusive).
 * Muted members' items and reactions and items the viewer reported are left out. Names follow the member list.
 */
export function feedPage(m: Master, f: TeamFeedState, viewer: string, muted: string[], names: Map<string, string>, before: number | null, limit: number | null) {
  const cfg = stampsOf(m).config;
  const n = Math.max(1, Math.min(cfg.pageMax, limit ?? cfg.pageDefault));
  const mute = new Set(muted);
  const visible = f.items.filter((x) => !mute.has(x.playerId) && !(x.reportedBy ?? []).includes(viewer) && (before === null || x.seq < before));
  const page = visible.slice(-n).reverse();
  const items: FeedItemView[] = page.map((x) => {
    const reacts = x.reactions.filter((r) => !mute.has(r.playerId));
    const counts = new Map<string, { count: number; mine: boolean }>();
    for (const r of reacts) {
      const c = counts.get(r.stampId) ?? { count: 0, mine: false };
      c.count += 1;
      if (r.playerId === viewer) c.mine = true;
      counts.set(r.stampId, c);
    }
    return {
      seq: x.seq, at: x.at, kind: x.kind, playerId: x.playerId, displayName: names.get(x.playerId) ?? x.displayName, mine: x.playerId === viewer,
      stampId: x.stampId ?? null, stampAsset: x.stampId ? stampAsset(x.stampId) : null, race: x.race ?? null,
      reactions: [...counts.entries()].map(([stampId, c]) => ({ stampId, ...c })).sort((a, b) => b.count - a.count || (a.stampId < b.stampId ? -1 : 1)),
      myReaction: reacts.find((r) => r.playerId === viewer)?.stampId ?? null,
    };
  });
  const oldest = page[page.length - 1];
  const more = oldest !== undefined && visible.some((x) => x.seq < oldest.seq);
  return { items, nextBefore: more ? oldest!.seq : null, latestSeq: f.seq };
}
