/**
 * アクティビティ (in-app activity center) — REQ-ACT-001..016, contracts/protocol.md §40.
 *
 * A per-player, bounded list of things that happened to the player while away (friend requests, rival results, likes,
 * cheer stamps, tournament results, gift arrivals, team goal results). Entries are written by the existing event sources
 * at the same points that queue a push (whatever the push preferences say: those only affect pushes), once per source
 * event id. The list is display + deep link only: it never grants anything and never offers a claim button.
 *
 * Pure state logic, no I/O. Names of other players are resolved at read time from the public profile directory
 * (renderActivityItems), so a deleted or banned player shows a neutral name; player names are never translated.
 */
import { AppError } from './errors.js';
import type { Master, PushCategory } from './master.js';
import type { PlayerState } from './player.js';
import type { PublicProfile } from './stats.js';

export const ACTIVITY_KINDS = [
  'friend_request', 'friend_accepted', 'rival_week', 'rival_record', 'stable_like', 'team_cheer', 'tournament_result',
  'gift_arrived', 'team_goal_tier', 'team_goal_week', 'replay_share',
  // Round 16 (integration): hosted cups (§42.7) and the season recap (§43)
  'cup_invited', 'cup_started', 'cup_finished', 'cup_cancelled', 'recap_ready',
] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export const ACTIVITY_SCREENS = ['friends', 'rival', 'stable', 'team_feed', 'tournaments', 'gift_box', 'team_goal', 'replay', 'whats_new', 'cups', 'recap'] as const;
export type ActivityScreen = typeof ACTIVITY_SCREENS[number];

interface KindMeta { category: PushCategory; screen: ActivityScreen; collapse: boolean }
/** REQ-ACT-003/005/006: the push category (the same split as the push settings), the deep link and whether entries collapse. */
export const ACTIVITY_META: Record<ActivityKind, KindMeta> = {
  friend_request: { category: 'friends', screen: 'friends', collapse: false },
  friend_accepted: { category: 'friends', screen: 'friends', collapse: false },
  rival_week: { category: 'friends', screen: 'rival', collapse: false },
  rival_record: { category: 'friends', screen: 'rival', collapse: false },
  stable_like: { category: 'friends', screen: 'stable', collapse: true },
  team_cheer: { category: 'friends', screen: 'team_feed', collapse: true },
  tournament_result: { category: 'events', screen: 'tournaments', collapse: false },
  gift_arrived: { category: 'gifts', screen: 'gift_box', collapse: true },
  team_goal_tier: { category: 'friends', screen: 'team_goal', collapse: false },
  team_goal_week: { category: 'friends', screen: 'team_goal', collapse: false },
  replay_share: { category: 'friends', screen: 'replay', collapse: false },
  cup_invited: { category: 'invites', screen: 'cups', collapse: false },
  cup_started: { category: 'friends', screen: 'cups', collapse: false },
  cup_finished: { category: 'friends', screen: 'cups', collapse: false },
  cup_cancelled: { category: 'friends', screen: 'cups', collapse: false },
  recap_ready: { category: 'season', screen: 'recap', collapse: false },
};

/** REQ-ACT-010: `progression.activity` (absent → ACTIVITY_DEFAULTS). */
export interface ActivityConfig { maxEntries: number; maxDays: number; collapseHours: number; pageSize: number; pageMax: number; badgeMax: number }
export const ACTIVITY_DEFAULTS: ActivityConfig = { maxEntries: 100, maxDays: 30, collapseHours: 24, pageSize: 20, pageMax: 50, badgeMax: 99 };
export const ACTIVITY_LIMITS = { maxEntries: [10, 500], maxDays: [1, 90], collapseHours: [0, 168], pageMax: [1, 100], badgeMax: [9, 999] } as const;
/** Source event ids remembered for idempotency (newest kept). */
export const ACTIVITY_SOURCE_KEEP = 500;
/** Senders remembered per collapsed entry (with their own count). */
export const ACTIVITY_ACTORS_KEEP = 20;
/** REQ-ACT-012: the name shown for a deleted, banned or unknown player (never the stored name). */
export const NEUTRAL_NAME = 'プレイヤー';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function activityConfig(m: Pick<Master, 'progression'>): ActivityConfig {
  return { ...ACTIVITY_DEFAULTS, ...(m.progression.activity ?? {}) };
}

/** REQ-ACT-010: boot and remote-config validation. */
export function activityProblems(m: Pick<Master, 'progression'>, path = 'progression.activity'): string[] {
  const raw = m.progression.activity;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object') return [`${path} must be an object`];
  const out: string[] = [];
  const known = Object.keys(ACTIVITY_DEFAULTS);
  for (const k of Object.keys(raw)) if (!known.includes(k) && !k.startsWith('_')) out.push(`${path}.${k} is unknown`);
  const c = activityConfig(m);
  const int = (k: keyof ActivityConfig, lo: number, hi: number) => {
    const v = c[k];
    if (!Number.isInteger(v) || v < lo || v > hi) out.push(`${path}.${k} must be an integer ${lo}..${hi}`);
  };
  for (const [k, [lo, hi]] of Object.entries(ACTIVITY_LIMITS)) int(k as keyof ActivityConfig, lo, hi);
  int('pageSize', 1, Number.isInteger(c.pageMax) ? c.pageMax : 1);
  return out;
}

export interface ActivityActor { id: string; name: string | null; n: number }
export interface ActivityEntry {
  id: number; kind: ActivityKind; at: number;
  /** When the (collapsed) entry started: later events join it while it is unread and within collapseHours. */
  firstAt: number;
  count: number;
  /** Newest first, at most ACTIVITY_ACTORS_KEEP. */
  actors: ActivityActor[];
  vars: Record<string, string>;
  linkId: string | null;
}
export interface ActivityState { seq: number; readUpTo: number; entries: ActivityEntry[]; sources: string[] }

const peek = (s: PlayerState) => (s as PlayerState & { activity?: ActivityState }).activity;
export function ensureActivity(s: PlayerState): ActivityState {
  const x = s as PlayerState & { activity?: ActivityState };
  x.activity ??= { seq: 0, readUpTo: 0, entries: [], sources: [] };
  return x.activity;
}
/** REQ-ACT-011: the one block list (the team-feed mute list, REQ-RIVAL-011). */
const blockedOf = (s: PlayerState): string[] => (s as PlayerState & { teamFeed?: { muted?: string[] } }).teamFeed?.muted ?? [];

export interface ActivityInput {
  kind: ActivityKind;
  /** The source event id (REQ-ACT-002): the same id is written once. */
  source: string;
  actor?: { id: string; name?: string | null } | null;
  vars?: Record<string, string>;
  linkId?: string | null;
}
export type RecordOutcome = 'recorded' | 'collapsed' | 'duplicate' | 'blocked' | 'skipped';

function prune(c: ActivityConfig, a: ActivityState, now: number) {
  const cut = now - c.maxDays * DAY;
  a.entries = a.entries.filter((e) => e.at > cut);
  if (a.entries.length > c.maxEntries) a.entries.splice(0, a.entries.length - c.maxEntries);
}

/**
 * REQ-ACT-002/006/011/013: write one event. Never throws for the caller's flow (an unknown kind is a programming error
 * and is skipped). Entries are kept oldest → newest in state; ids grow with every write (a collapsed entry gets a new id
 * and moves to the top, so it is unread again).
 */
export function recordActivity(m: Pick<Master, 'progression'>, s: PlayerState, input: ActivityInput, now: number): RecordOutcome {
  const meta = ACTIVITY_META[input.kind];
  if (!meta || !input.source) return 'skipped';
  if (s.deletion?.status === 'deleting') return 'skipped';
  const actor = input.actor ?? null;
  if (actor && actor.id === s.id) return 'skipped';
  const a = ensureActivity(s);
  if (a.sources.includes(input.source)) return 'duplicate';
  a.sources.push(input.source);
  if (a.sources.length > ACTIVITY_SOURCE_KEEP) a.sources.splice(0, a.sources.length - ACTIVITY_SOURCE_KEEP);
  if (actor && blockedOf(s).includes(actor.id)) return 'blocked';
  const c = activityConfig(m);
  prune(c, a, now);
  const vars = input.vars ?? {};
  const linkId = input.linkId ?? null;
  if (meta.collapse && c.collapseHours > 0) {
    const open = [...a.entries].reverse().find((e) => e.kind === input.kind && e.linkId === linkId && e.id > a.readUpTo && now - e.firstAt < c.collapseHours * HOUR);
    if (open) {
      open.count += 1;
      if (actor) {
        const prev = open.actors.find((x) => x.id === actor.id);
        open.actors = [{ id: actor.id, name: actor.name ?? prev?.name ?? null, n: (prev?.n ?? 0) + 1 }, ...open.actors.filter((x) => x.id !== actor.id)].slice(0, ACTIVITY_ACTORS_KEEP);
      }
      open.at = now;
      open.vars = { ...open.vars, ...vars };
      open.id = ++a.seq;
      a.entries = [...a.entries.filter((e) => e !== open), open];
      return 'collapsed';
    }
  }
  a.entries.push({ id: ++a.seq, kind: input.kind, at: now, firstAt: now, count: 1, actors: actor ? [{ id: actor.id, name: actor.name ?? null, n: 1 }] : [], vars, linkId });
  prune(c, a, now);
  return 'recorded';
}

/** An entry as the player may see it now: blocked senders' contributions removed (null = nothing left to show). */
function visible(e: ActivityEntry, blocked: string[]): ActivityEntry | null {
  if (blocked.length === 0 || e.actors.length === 0) return e;
  const hidden = e.actors.filter((x) => blocked.includes(x.id));
  if (hidden.length === 0) return e;
  const count = e.count - hidden.reduce((n, x) => n + x.n, 0);
  if (count <= 0) return null;
  return { ...e, count, actors: e.actors.filter((x) => !blocked.includes(x.id)) };
}

function visibleEntries(m: Pick<Master, 'progression'>, s: PlayerState, now: number): ActivityEntry[] {
  const a = peek(s);
  if (!a) return [];
  const cut = now - activityConfig(m).maxDays * DAY;
  const blocked = blockedOf(s);
  const out: ActivityEntry[] = [];
  for (let i = a.entries.length - 1; i >= 0; i--) {
    const e = a.entries[i]!;
    if (e.at <= cut) continue;
    const v = visible(e, blocked);
    if (v) out.push(v);
  }
  return out; // newest first
}

/** REQ-ACT-009: the home bell's number. */
export function activityBadge(m: Pick<Master, 'progression'>, s: PlayerState, now: number) {
  const readUpTo = peek(s)?.readUpTo ?? 0;
  const n = visibleEntries(m, s, now).filter((e) => e.id > readUpTo).length;
  return { unread: Math.min(n, activityConfig(m).badgeMax) };
}

const CURSOR_RE = /^[0-9]{1,12}$/;
/** REQ-ACT-007: query validation (400 on a bad cursor / limit). */
export function activityQuery(m: Pick<Master, 'progression'>, q: URLSearchParams): { cursor: number | null; limit: number } {
  const c = activityConfig(m);
  const cur = q.get('cursor');
  const lim = q.get('limit');
  if (cur !== null && cur !== '' && !CURSOR_RE.test(cur)) throw new AppError('BAD_REQUEST', 'bad cursor');
  let limit = c.pageSize;
  if (lim !== null && lim !== '') {
    if (!/^[0-9]{1,3}$/.test(lim) || Number(lim) < 1 || Number(lim) > c.pageMax) throw new AppError('BAD_REQUEST', `limit must be 1..${c.pageMax}`);
    limit = Number(lim);
  }
  return { cursor: cur ? Number(cur) : null, limit };
}
export const parseUpTo = (x: string | undefined): number | null => {
  if (x === undefined) return null;
  if (!CURSOR_RE.test(x)) throw new AppError('BAD_REQUEST', 'bad upTo');
  return Number(x);
};

/** A raw page item (names not resolved yet; renderActivityItems finishes it). */
export interface ActivityRawItem { id: string; kind: ActivityKind; category: PushCategory; at: number; count: number; unread: boolean; actors: { playerId: string; name: string | null }[]; vars: Record<string, string>; link: { screen: ActivityScreen; id: string | null } }

/** REQ-ACT-001/007: one page, newest first. */
export function activityPage(m: Pick<Master, 'progression'>, s: PlayerState, now: number, cursor: number | null, limit: number, whatsNew = 0) {
  const c = activityConfig(m);
  const readUpTo = peek(s)?.readUpTo ?? 0;
  const all = visibleEntries(m, s, now);
  const unread = Math.min(all.filter((e) => e.id > readUpTo).length, c.badgeMax);
  const from = cursor === null ? all : all.filter((e) => e.id < cursor);
  const page = from.slice(0, Math.max(1, Math.min(limit, c.pageMax)));
  const more = from.length > page.length;
  const items: ActivityRawItem[] = page.map((e) => ({
    id: String(e.id), kind: e.kind, category: ACTIVITY_META[e.kind].category, at: e.at, count: e.count, unread: e.id > readUpTo,
    actors: e.actors.slice(0, 3).map((x) => ({ playerId: x.id, name: x.name })), vars: { ...e.vars },
    link: { screen: ACTIVITY_META[e.kind].screen, id: e.linkId },
  }));
  return { items, nextCursor: more && page.length > 0 ? String(page[page.length - 1]!.id) : null, unread, readUpTo: String(readUpTo), links: { whatsNew } };
}

/** REQ-ACT-008: idempotent, never goes back, never past the newest entry. */
export function markActivityRead(m: Pick<Master, 'progression'>, s: PlayerState, upTo: number | null, now: number) {
  const a = ensureActivity(s);
  const target = Math.min(upTo ?? a.seq, a.seq);
  if (target > a.readUpTo) a.readUpTo = target;
  return { readUpTo: String(a.readUpTo), unread: activityBadge(m, s, now).unread };
}

// ------------------------------------------------------------------------------------------------ texts (REQ-ACT-014)

/** Japanese texts; the English is in i18n/en.ts (applied at the response boundary, §23). `{name}` is never translated. */
export const ACTIVITY_TEXT = {
  friend_request: '{name}さんからフレンド申請が届きました',
  friend_accepted: '{name}さんとフレンドになりました',
  rival_win: 'ライバル対決の結果：勝ち',
  rival_lose: 'ライバル対決の結果：負け',
  rival_draw: 'ライバル対決の結果：引き分け',
  rival_no_contest: 'ライバル対決の結果：不成立',
  rival_not_enough: 'ライバル対決の結果：レース数が足りず結果なし',
  rival_record: 'ライバルの{name}さんが{course}のタイムアタックであなたの今週の記録を上回りました',
  stable_like_one: '{name}さんがマイ厩舎にいいねしました',
  stable_like_many: 'マイ厩舎に{n}件のいいねが届きました',
  team_cheer_one: '{name}さんがあなたのレースに応援スタンプを送りました',
  team_cheer_many: 'あなたのレースに{n}件の応援スタンプが届きました',
  tournament_result: '「{tournament}」の最終順位は{n}位でした',
  gift_one: 'プレゼントボックスにプレゼントが届きました',
  gift_many: 'プレゼントボックスに{n}件のプレゼントが届きました',
  team_goal_tier: '支部の共同目標が{n}段目に到達しました',
  team_goal_week: '先週の支部の共同目標は{n}段目まで届きました',
  team_goal_week_none: '先週の支部の共同目標は段に届きませんでした',
  replay_share: '{name}さんがリプレイを共有しました',
  // {cup} is the cup name the host typed (never translated)
  cup_invited: '{name}さんから「{cup}」に招待されました',
  cup_started: '「{cup}」が始まりました',
  cup_finished: '「{cup}」の順位は{n}位でした',
  cup_cancelled: '「{cup}」は中止になりました',
  recap_season: '{y}年{m}月シーズンの振り返りができました',
  recap_year: '{y}年の振り返りができました',
} as const;

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');

export function activityText(kind: ActivityKind, count: number, vars: Record<string, string>, name: string): string {
  const T = ACTIVITY_TEXT;
  const v = { ...vars, name, n: vars.n ?? String(count) };
  switch (kind) {
    case 'friend_request': return fill(T.friend_request, v);
    case 'friend_accepted': return fill(T.friend_accepted, v);
    case 'rival_week': {
      const o = vars.outcome;
      return o === 'win' ? T.rival_win : o === 'lose' ? T.rival_lose : o === 'draw' ? T.rival_draw : o === 'no_contest' ? T.rival_no_contest : T.rival_not_enough;
    }
    case 'rival_record': return fill(T.rival_record, v);
    case 'stable_like': return count > 1 ? fill(T.stable_like_many, { n: String(count) }) : fill(T.stable_like_one, v);
    case 'team_cheer': return count > 1 ? fill(T.team_cheer_many, { n: String(count) }) : fill(T.team_cheer_one, v);
    case 'tournament_result': return fill(T.tournament_result, v);
    case 'gift_arrived': return count > 1 ? fill(T.gift_many, { n: String(count) }) : T.gift_one;
    case 'team_goal_tier': return fill(T.team_goal_tier, v);
    case 'team_goal_week': return vars.n && vars.n !== '0' ? fill(T.team_goal_week, v) : T.team_goal_week_none;
    case 'replay_share': return fill(T.replay_share, v);
    case 'cup_invited': return fill(T.cup_invited, v);
    case 'cup_started': return fill(T.cup_started, v);
    case 'cup_finished': return fill(T.cup_finished, v);
    case 'cup_cancelled': return fill(T.cup_cancelled, v);
    case 'recap_ready': return fill(vars.kind === 'year' ? T.recap_year : T.recap_season, v);
  }
}

/** The public bits of a profile the renderer needs (`banned` is set by publicProfile for a banned account). */
export type ActivityProfile = Pick<PublicProfile, 'playerId' | 'displayName'> & { banned?: boolean };

/**
 * REQ-ACT-012: names from the directory now — a missing profile (deleted account) or a banned one shows NEUTRAL_NAME.
 * `profiles` null = the directory could not be reached: the stored names are used (never an error for the list).
 */
export function renderActivityItems(items: ActivityRawItem[], profiles: ActivityProfile[] | null) {
  const byId = new Map((profiles ?? []).map((p) => [p.playerId, p]));
  const nameOf = (id: string, stored: string | null) => {
    if (profiles === null) return stored ?? NEUTRAL_NAME;
    const p = byId.get(id);
    return !p || p.banned ? NEUTRAL_NAME : p.displayName;
  };
  return items.map(({ vars, ...it }) => {
    const actors = it.actors.map((x) => ({ playerId: x.playerId, name: nameOf(x.playerId, x.name) }));
    const text = activityText(it.kind, it.count, vars, actors[0]?.name ?? NEUTRAL_NAME);
    return { ...it, actors, text };
  });
}

/** Every player id a page names (for one directory lookup). */
export const actorIdsOf = (items: ActivityRawItem[]) => [...new Set(items.flatMap((x) => x.actors.map((a) => a.playerId)))];
