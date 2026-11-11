/**
 * 観戦中の応援 — REQ-CHEER-001..016, contracts/protocol.md §55.
 *
 * Spectators of a live race (§8.4) send one of a few preset cheers for a horse (no free text). The race room collects them
 * in one-second windows and sends each socket at most one small `cheers` message per window: spectators see the burst,
 * racers may show a quiet 「応援 ×n」 for their own horse. Cheers travel next to the lockstep stream, never in it: they are
 * not inputs, never enter the replay log (§7), the checksums (§5) or the result hash (§6), and the room core never sees
 * them. Nothing is granted or sold (no E number, no paid cheers, no tipping / 投げ銭).
 *
 * Pure: the race room Durable Object (do/raceRoom.ts) owns the sockets and the block lists and calls these functions.
 */
import { bettingWordsIn } from './bettingWords.js';

/** The preset cheers (REQ-CHEER-002). Order = the wire order of the buttons. */
export const CHEER_KINDS = ['go', 'close', 'hold'] as const;
export type CheerKind = typeof CHEER_KINDS[number];

/** What a cheer says (the client shows these; English is the same table). Never betting words (REQ-CHEER-014, cheerTextProblems in the tests). */
export const CHEER_TEXT: Record<CheerKind, { ja: string; en: string }> = {
  go: { ja: 'いけ！', en: 'Go!' },
  close: { ja: '差せ！', en: 'Close in!' },
  hold: { ja: '粘れ！', en: 'Hang on!' },
};

/** REQ-CHEER-004: one cheer per spectator every 2 s (the room enforces it; the client greys the buttons). */
export const CHEER_MIN_INTERVAL_MS = 2000;
/** REQ-CHEER-005: the room sends at most one `cheers` message per socket per window. */
export const CHEER_WINDOW_MS = 1000;
/** REQ-CHEER-011: the per-race aggregate counts cheers in buckets of this many ticks (2 s at 20 Hz). */
export const CHEER_BUCKET_TICKS = 40;
/** REQ-CHEER-011: a bucket needs at least this many cheers to be a 「応援の多かった瞬間」. */
export const CHEER_MOMENT_MIN = 3;
/** REQ-CHEER-011: at most this many moments per race. */
export const CHEER_MOMENTS_MAX = 3;

export const isCheerKind = (k: unknown): k is CheerKind => typeof k === 'string' && (CHEER_KINDS as readonly string[]).includes(k);

/** Modes whose races can be watched (§8.4) and therefore cheered (REQ-CHEER-001). */
export const CHEER_MODES = ['friend', 'cup', 'ranked', 'event', 'tournament'] as const;
export const cheerableMode = (mode: string) => (CHEER_MODES as readonly string[]).includes(mode);

/** REQ-CHEER-003: what a spectator's `start.spectator.cheer` advertises (absent = the room takes no cheers). */
export function cheerAdvert() {
  return { kinds: [...CHEER_KINDS], minIntervalMs: CHEER_MIN_INTERVAL_MS, windowMs: CHEER_WINDOW_MS };
}

/** REQ-CHEER-003: the spectator `start` with `spectator.cheer` added when the room takes cheers (old clients ignore it). */
export function withCheerAdvert<S extends { t: string; spectator?: { delayMs: number } }>(start: S, enabled: boolean): S {
  if (!enabled || start.t !== 'start' || !start.spectator) return start;
  return { ...start, spectator: { ...start.spectator, cheer: cheerAdvert() } };
}

export type CheerRefusal = 'CHEER_OFF' | 'NOT_SPECTATOR' | 'CHEER_NOT_LIVE' | 'CHEER_RATE_LIMITED' | 'CHEER_UNAVAILABLE' | 'BAD_MESSAGE';

/**
 * REQ-CHEER-004/006: may this spectator cheer now? `sentTick` = last tick the room sent them (-1 = the race has not started
 * for them), `fin` = they already got the final; `lastAt` = their last accepted cheer (null = none).
 */
export function cheerAdmit(o: { enabled: boolean; spectator: boolean; sentTick: number; fin: boolean; lastAt: number | null; slot: number; entrants: number; now: number }): CheerRefusal | null {
  if (!o.enabled) return 'CHEER_OFF';
  if (!o.spectator) return 'NOT_SPECTATOR';
  if (o.slot < 0 || o.slot >= o.entrants) return 'BAD_MESSAGE';
  if (o.sentTick < 0 || o.fin) return 'CHEER_NOT_LIVE';
  if (o.lastAt !== null && o.now - o.lastAt < CHEER_MIN_INTERVAL_MS && o.now >= o.lastAt) return 'CHEER_RATE_LIMITED';
  return null;
}

/** One accepted cheer waiting for the window to close. `from` = the sender's player id (never sent to anyone). */
export interface PendingCheer { from: string; slot: number; kind: CheerKind }

/** The wire message (§55.3): `[slot, kind, count]` sorted by slot, then kind order. No sender ids. */
export type CheersMessage = { t: 'cheers'; n: [number, CheerKind, number][] };

/** One socket that may receive the window. `playerId` null = unknown (an attachment from an older build) → gets nothing. */
export interface CheerRecipient<K> { key: K; playerId: string | null }

/**
 * REQ-CHEER-008: `hidden(recipient, sender)` — true when either blocked the other (the single block list, §47). It returns
 * null when the recipient's own block list is not known yet: that recipient gets nothing this window (fail closed).
 */
export type CheerHidden = (recipient: string, sender: string) => boolean | null;

function countsOf(cheers: PendingCheer[]): CheersMessage | null {
  if (cheers.length === 0) return null;
  const m = new Map<string, number>();
  for (const c of cheers) m.set(`${c.slot}|${c.kind}`, (m.get(`${c.slot}|${c.kind}`) ?? 0) + 1);
  const n = [...m.entries()].map(([k, count]) => {
    const [slot, kind] = k.split('|') as [string, CheerKind];
    return [Number(slot), kind, count] as [number, CheerKind, number];
  });
  n.sort((a, b) => a[0] - b[0] || CHEER_KINDS.indexOf(a[1]) - CHEER_KINDS.indexOf(b[1]));
  return { t: 'cheers', n };
}

/**
 * REQ-CHEER-005/008: the window's message for each recipient, serialized once per distinct set of hidden cheers (so a room
 * without blocks serializes one string for everyone). A recipient whose filtered window is empty gets null (nothing sent).
 * A sender's own cheers are always visible to them.
 */
export function cheerFanout<K>(cheers: PendingCheer[], recipients: CheerRecipient<K>[], hidden: CheerHidden): Map<K, string | null> {
  const out = new Map<K, string | null>();
  const cache = new Map<string, string | null>();
  for (const r of recipients) {
    let skip: number[] | null = r.playerId === null ? null : [];
    for (let i = 0; i < cheers.length && skip; i++) {
      const c = cheers[i]!;
      if (c.from === r.playerId) continue;
      const h = hidden(r.playerId!, c.from);
      if (h === null) skip = null;
      else if (h) skip.push(i);
    }
    if (skip === null) { out.set(r.key, null); continue; }
    const sig = skip.join(',');
    if (!cache.has(sig)) {
      const msg = countsOf(skip.length ? cheers.filter((_, i) => !skip!.includes(i)) : cheers);
      cache.set(sig, msg ? JSON.stringify(msg) : null);
    }
    out.set(r.key, cache.get(sig)!);
  }
  return out;
}

/** REQ-CHEER-008: either side blocking hides the cheer. Unknown recipient list → null; unknown sender list → hidden (fail closed). */
export function blockHidden(lists: Map<string, ReadonlySet<string> | null>): CheerHidden {
  return (recipient, sender) => {
    const mine = lists.get(recipient);
    if (!mine) return null;
    if (mine.has(sender)) return true;
    const theirs = lists.get(sender);
    return !theirs || theirs.has(recipient);
  };
}

// ------------------------------------------------------------------------------------------------ the race's aggregate

/**
 * REQ-CHEER-011: what the room keeps per race — counts only (no sender ids, no kinds per sender): buckets of
 * CHEER_BUCKET_TICKS race ticks as the sender saw them, and the total. Kept in the room's storage next to (never inside)
 * the core snapshot, and written once to R2 beside the replay log when the last spectator is done.
 */
export interface CheerTally { v: 1; total: number; buckets: [number, number][]; written?: boolean }

export const emptyTally = (): CheerTally => ({ v: 1, total: 0, buckets: [] });

export function tallyAdd(t: CheerTally, tick: number) {
  const b = Math.max(0, Math.floor(tick / CHEER_BUCKET_TICKS));
  const row = t.buckets.find((x) => x[0] === b);
  if (row) row[1]++;
  else { t.buckets.push([b, 1]); t.buckets.sort((x, y) => x[0] - y[0]); }
  t.total++;
}

/** The R2 file `replays/<raceId>.cheers.json` (§55.6): small, no player ids. */
export interface CheerSummary { v: 1; bucketTicks: number; total: number; buckets: [number, number][] }

export const cheerSummaryKey = (raceId: string) => `replays/${raceId}.cheers.json`;

export function cheerSummary(t: CheerTally): CheerSummary {
  return { v: 1, bucketTicks: CHEER_BUCKET_TICKS, total: t.total, buckets: t.buckets.map(([b, n]) => [b, n] as [number, number]) };
}

/** A stored summary, or null when it is missing / unreadable / not this format (the marker is optional, REQ-CHEER-012). */
export function parseCheerSummary(raw: string | null): CheerSummary | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as CheerSummary;
    if (s?.v !== 1 || !Number.isInteger(s.bucketTicks) || s.bucketTicks <= 0 || !Array.isArray(s.buckets) || s.buckets.length > 10_000) return null;
    if (!s.buckets.every((b) => Array.isArray(b) && b.length === 2 && Number.isInteger(b[0]) && b[0] >= 0 && Number.isInteger(b[1]) && b[1] > 0)) return null;
    return { v: 1, bucketTicks: s.bucketTicks, total: s.buckets.reduce((a, b) => a + b[1], 0), buckets: s.buckets };
  } catch { return null; }
}

/**
 * REQ-CHEER-012: 「応援の多かった瞬間」 — the busiest buckets (≥ CHEER_MOMENT_MIN cheers, at most CHEER_MOMENTS_MAX, more cheers
 * first, the earlier on a tie), returned in race order as the bucket's first tick. Same summary → same moments.
 */
export function cheerMoments(s: CheerSummary | null): { tick: number; count: number }[] {
  if (!s) return [];
  return s.buckets
    .filter(([, n]) => n >= CHEER_MOMENT_MIN)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, CHEER_MOMENTS_MAX)
    .sort((a, b) => a[0] - b[0])
    .map(([b, n]) => ({ tick: b * s.bucketTicks, count: n }));
}

/** REQ-CHEER-014: the cheer texts (both languages) carry no betting words — checked by the tests (test/cheer.test.ts). */
export function cheerTextProblems(): string[] {
  const out: string[] = [];
  for (const k of CHEER_KINDS) for (const lang of ['ja', 'en'] as const) {
    const w = bettingWordsIn(CHEER_TEXT[k][lang]);
    if (w.length) out.push(`cheer ${k} (${lang}): betting words ${w.join(', ')}`);
  }
  return out;
}
