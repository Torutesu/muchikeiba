/**
 * ブロック管理 — REQ-RPT-010..012/017, contracts/protocol.md §47.1–47.3.
 *
 * There is ONE block list: the team-feed mute list (`PlayerState.teamFeed.muted`, REQ-TEAMFEED-006), which the activity
 * list (§40), the rival pairing (§28), the hall (§34), saved replays (§37) and, from Round 17, マイ厩舎 (§25) already read.
 * The team feed's mute route, the rival block, a report's "also block" and the block screen all change that list through
 * `setBlocked`, which also writes the block_add / block_remove KPI rows (only when the list really changed).
 */
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';
import type { PublicProfile } from './stats.js';
import { playerMute, stampsOf } from './teamFeed.js';
import { NEUTRAL_NAME } from './activity.js';

export const BLOCK_ORIGINS = ['blocks', 'report', 'team_feed', 'rival'] as const;
export type BlockOrigin = typeof BLOCK_ORIGINS[number];

/** The block list, read without creating state. */
export const blockListOf = (s: PlayerState): string[] => (s as PlayerState & { teamFeed?: { muted?: string[] } }).teamFeed?.muted ?? [];
export const isBlocking = (s: PlayerState, other: string) => blockListOf(s).includes(other);

/** REQ-RPT-010/017: add or remove one player; KPI only when the list changed. Self → 400, full → TEAM_LIMIT (playerMute). */
export function setBlocked(m: Master, s: PlayerState, target: string, blocked: boolean, origin: BlockOrigin, emit: Emit | null) {
  const had = isBlocking(s, target);
  const r = playerMute(m, s, target, blocked);
  if (blocked && !had) emit?.({ name: 'block_add', s1: origin, count: r.muted.length });
  if (!blocked && had) emit?.({ name: 'block_remove', s1: origin, count: r.muted.length });
  return { playerId: target, blocked, count: r.muted.length, max: stampsOf(m).config.muteMax, changed: had !== blocked };
}

export const BLOCK_FEATURES = ['activity', 'team_feed', 'rival', 'stable', 'hall', 'replays', 'cups'] as const;
/** REQ-RPT-011: what a block does, one line per feature (protocol §47.1; English in i18n/en.ts). */
export const BLOCK_EFFECTS: Record<typeof BLOCK_FEATURES[number], string> = {
  activity: '相手からのお知らせが届かなくなります',
  team_feed: '支部フィードで相手のスタンプと応援が見えなくなります',
  rival: 'ライバルに組まれなくなります',
  stable: 'お互いのマイ厩舎を開けず、いいねもできなくなります',
  hall: 'お互いの殿堂が見られなくなります',
  replays: 'お互いの公開リプレイが見られなくなります',
  cups: '主催カップでは同じカップに入れません（大会では同じレースになることがあります）',
};

/** The ids of GET /v1/blocks, newest block first (names are resolved by the caller from the directory). */
export function blockIds(s: PlayerState): string[] {
  return [...blockListOf(s)].reverse();
}

/** REQ-RPT-011: GET /v1/blocks with current names (deleted / banned / unknown → the neutral name; never translated). */
export function blocksView(m: Master, ids: string[], profiles: PublicProfile[] | null) {
  const byId = new Map((profiles ?? []).map((p) => [p.playerId, p]));
  return {
    blocked: ids.map((id) => {
      const p = byId.get(id);
      return { playerId: id, name: p && !p.banned ? p.displayName : NEUTRAL_NAME };
    }),
    count: ids.length,
    max: stampsOf(m).config.muteMax,
    effects: BLOCK_FEATURES.map((feature) => ({ feature, text: BLOCK_EFFECTS[feature] })),
  };
}

