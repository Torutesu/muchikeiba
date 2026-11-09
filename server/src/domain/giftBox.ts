/**
 * プレゼントボックス (REQ-BOX-001..014, contracts/protocol.md §26).
 *
 * Free rewards that have no in-flow claim screen (ops compensations and grants, the inviter's invite bonus, event /
 * tournament / branch / league / season rewards) are delivered here instead of straight into the wallet; the player
 * moves them into the wallet with a claim. The box changes routing only, never amounts.
 *
 *   - contents are free coins and items only — paid coins can never be put in (資金決済法);
 *   - horse / broodmare / pass XP parts of a reward are granted at once (they are not box contents);
 *   - entries expire (default 30 days, compensation 90, `null` = never); expiry is lazy (every transaction and the
 *     list) plus the player object's alarm (nextGiftWake);
 *   - a full box auto-claims the earliest-expiring non-compensation entry; nothing is ever dropped silently.
 */
import { AppError } from './errors.js';
import type { ItemQty, Master, Reward } from './master.js';
import type { PlayerState } from './player.js';
import type { KpiEvent } from './kpi.js';
import { addItems, grantReward } from './items.js';
import { grantFree } from './wallet.js';
import { enqueuePush } from './push.js';

export const GIFT_SOURCES = ['ops_compensation', 'ops_grant', 'invite', 'event', 'tournament', 'team', 'league', 'season'] as const;
export type GiftSource = typeof GIFT_SOURCES[number];

/** Display titles (Japanese; the English is in i18n/en.ts and applied at the response boundary). */
export const GIFT_TITLES = {
  ops_compensation: 'お詫びの品',
  ops_compensation_maintenance: 'メンテナンスのお詫び',
  ops_compensation_bug: '不具合のお詫び',
  ops_grant: '運営からの贈り物',
  invite: '招待ボーナス',
  event: 'イベントの順位報酬',
  tournament: '大会の賞品',
  team: '支部のシーズン報酬',
  league: '支部対抗シーズンの報酬',
  season: 'シーズンの報酬',
} as const;
export type GiftTitleKey = keyof typeof GIFT_TITLES;
/** Title keys ops may choose for a grant / compensation. */
export const OPS_TITLE_KEYS = ['ops_compensation', 'ops_compensation_maintenance', 'ops_compensation_bug', 'ops_grant'] as const;
export type OpsTitleKey = typeof OPS_TITLE_KEYS[number];

/** Box contents: free coins and items only. There is deliberately no paid-coin field (REQ-BOX-002). */
export interface GiftContents { freeCoins?: number; items?: ItemQty[] }
export type HoldReason = 'item_cap' | 'coin_cap';
export interface GiftEntry {
  id: string; source: GiftSource; titleKey: GiftTitleKey;
  /** Idempotency of delivery (one entry per ref, REQ-BOX-008). Also the ledger ref suffix. */
  ref: string;
  contents: GiftContents;
  createdAt: number; expiresAt: number | null;
  status: 'unclaimed' | 'claimed' | 'expired';
  /** Claimed / expired at. */
  doneAt?: number;
  how?: 'one' | 'all' | 'overflow';
  /** The last claim attempt left it in the box (REQ-BOX-005). */
  held?: { reason: HoldReason; itemId?: string; at: number };
  /** Final rank of an event / tournament / season / branch reward (display only). */
  rank?: number | null;
  /** Internal: the ledger reason used on claim (may hold an ops reason; never sent to the player). */
  note: string;
}
export interface GiftBoxState { seq: number; box: GiftEntry[]; history: GiftEntry[] }

export interface GiftBoxConfig {
  enabled: boolean;
  expiryDays: { default: number; bySource?: Partial<Record<GiftSource, number | null>> };
  maxUnclaimed: number;
  historyDays: number;
  historyKeep: number;
  holdCaps: { freeCoins: number; itemQty: number };
  expiringSoonDays: number;
  pushSources?: GiftSource[];
}

/** Code-side bounds of the remote-configurable values (REQ-BOX-012). */
export const GIFT_BOX_LIMITS = {
  defaultDays: [7, 180], sourceDays: [7, 365], maxUnclaimed: [50, 1000], historyDays: [30, 180], historyKeep: [50, 1000],
  holdFreeCoins: [100_000, 99_999_999], holdItemQty: [99, 999_999], expiringSoonDays: [1, 7], opsExpiryDays: [1, 365],
} as const;
export const GIFT_PUSH_TEMPLATE = 'gift_arrived';
const DAY = 86_400_000;

export function giftBoxConfig(m: Master): GiftBoxConfig | null {
  const c = m.progression.giftBox;
  return c && c.enabled ? c : null;
}

export function ensureGiftBox(s: PlayerState): GiftBoxState {
  s.giftBox ??= { seq: 0, box: [], history: [] };
  return s.giftBox;
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const inRange = (x: unknown, [lo, hi]: readonly [number, number]) => isInt(x) && x >= lo && x <= hi;

/** Validation of `progression.giftBox` (boot and every remote-config version). */
export function giftBoxProblems(m: Master): string[] {
  const c = m.progression.giftBox as GiftBoxConfig | undefined;
  if (c === undefined) return [];
  const p: string[] = [];
  const L = GIFT_BOX_LIMITS;
  if (!c || typeof c !== 'object') return ['giftBox: must be an object'];
  if (typeof c.enabled !== 'boolean') p.push('giftBox.enabled must be a boolean');
  if (!c.expiryDays || typeof c.expiryDays !== 'object') p.push('giftBox.expiryDays is required');
  else {
    if (!inRange(c.expiryDays.default, L.defaultDays)) p.push(`giftBox.expiryDays.default must be an integer ${L.defaultDays[0]}..${L.defaultDays[1]}`);
    for (const [k, v] of Object.entries(c.expiryDays.bySource ?? {})) {
      if (!(GIFT_SOURCES as readonly string[]).includes(k)) p.push(`giftBox.expiryDays.bySource: unknown source ${k}`);
      if (v !== null && !inRange(v, L.sourceDays)) p.push(`giftBox.expiryDays.bySource.${k} must be null (no expiry) or an integer ${L.sourceDays[0]}..${L.sourceDays[1]}`);
    }
    const comp = c.expiryDays.bySource?.ops_compensation;
    if (comp !== undefined && comp !== null && isInt(c.expiryDays.default) && comp < c.expiryDays.default) p.push('giftBox: compensation must not expire sooner than the default');
  }
  if (!inRange(c.maxUnclaimed, L.maxUnclaimed)) p.push(`giftBox.maxUnclaimed must be an integer ${L.maxUnclaimed[0]}..${L.maxUnclaimed[1]}`);
  if (!inRange(c.historyDays, L.historyDays)) p.push(`giftBox.historyDays must be an integer ${L.historyDays[0]}..${L.historyDays[1]}`);
  if (!inRange(c.historyKeep, L.historyKeep)) p.push(`giftBox.historyKeep must be an integer ${L.historyKeep[0]}..${L.historyKeep[1]}`);
  if (!c.holdCaps || !inRange(c.holdCaps.freeCoins, L.holdFreeCoins) || !inRange(c.holdCaps.itemQty, L.holdItemQty)) {
    p.push(`giftBox.holdCaps needs freeCoins ${L.holdFreeCoins[0]}..${L.holdFreeCoins[1]} and itemQty ${L.holdItemQty[0]}..${L.holdItemQty[1]}`);
  }
  if (!inRange(c.expiringSoonDays, L.expiringSoonDays)) p.push(`giftBox.expiringSoonDays must be an integer ${L.expiringSoonDays[0]}..${L.expiringSoonDays[1]}`);
  for (const src of c.pushSources ?? []) if (!(GIFT_SOURCES as readonly string[]).includes(src)) p.push(`giftBox.pushSources: unknown source ${src}`);
  if ((c.pushSources ?? []).length > 0 && !m.push?.templates?.[GIFT_PUSH_TEMPLATE]) p.push(`giftBox.pushSources needs the push template ${GIFT_PUSH_TEMPLATE}`);
  const known = Object.keys(c).filter((k) => !['enabled', 'expiryDays', 'maxUnclaimed', 'historyDays', 'historyKeep', 'holdCaps', 'expiringSoonDays', 'pushSources'].includes(k));
  for (const k of known) if (!k.startsWith('_')) p.push(`giftBox: unknown key ${k}`);
  return p;
}

/** Expiry of a new entry: an explicit override (ops), else per source, else the default. `null` = never. */
function expiryOf(c: GiftBoxConfig, source: GiftSource, override: number | null | undefined, now: number): number | null {
  const days = override !== undefined ? override : c.expiryDays.bySource?.[source] !== undefined ? c.expiryDays.bySource[source]! : c.expiryDays.default;
  return days === null ? null : now + days * DAY;
}

const itemCount = (g: GiftContents) => (g.items ?? []).reduce((a, x) => a + x.qty, 0);
const boxable = (r: Reward): GiftContents => {
  const out: GiftContents = {};
  if (r.freeCoins) out.freeCoins = r.freeCoins;
  if (r.items?.length) out.items = r.items.map((x) => ({ itemId: x.itemId, qty: x.qty }));
  return out;
};

export interface DeliverInput {
  source: GiftSource; titleKey?: GiftTitleKey; ref: string; reward: Reward;
  /** Ledger reason on claim (or on the direct grant when the box is off). */
  note: string;
  /** Ops override: days (1..365) or null = no expiry. */
  expiryDays?: number | null;
  rank?: number | null;
}
export type DeliverResult =
  | { status: 'boxed'; giftId: string; expiresAt: number | null; duplicate: boolean }
  | { status: 'granted' }
  | { status: 'forfeited' }
  | { status: 'empty' };

/**
 * Delivers a free reward: into the box when it is on, else straight into the wallet (the old behaviour). The caller's
 * own once-only guard stays in charge of idempotency; a second delivery with the same ref is a no-op on top.
 */
export function deliverGift(m: Master, s: PlayerState, d: DeliverInput, now: number, emit?: (e: KpiEvent) => void): DeliverResult {
  const c = giftBoxConfig(m);
  if (!c) {
    grantReward(s, d.reward, now, d.note, d.ref, m);
    return { status: 'granted' };
  }
  if (s.deletion?.status === 'deleting') return { status: 'forfeited' };
  // horse / broodmare / pass XP are not box contents: granted as before
  const rest: Reward = {};
  if (d.reward.horse) rest.horse = d.reward.horse;
  if (d.reward.broodmare) rest.broodmare = d.reward.broodmare;
  if (d.reward.passXp) rest.passXp = d.reward.passXp;
  if (Object.keys(rest).length > 0) grantReward(s, rest, now, d.note, d.ref, m);
  const contents = boxable(d.reward);
  if (!contents.freeCoins && !contents.items) return Object.keys(rest).length > 0 ? { status: 'granted' } : { status: 'empty' };
  const b = ensureGiftBox(s);
  const dup = b.box.find((e) => e.ref === d.ref) ?? b.history.find((e) => e.ref === d.ref);
  if (dup) return { status: 'boxed', giftId: dup.id, expiresAt: dup.expiresAt, duplicate: true };
  if (b.box.length >= c.maxUnclaimed) makeRoom(m, c, s, now, emit);
  const e: GiftEntry = {
    id: `gift_${++b.seq}`, source: d.source, titleKey: d.titleKey ?? defaultTitle(d.source), ref: d.ref, contents,
    createdAt: now, expiresAt: expiryOf(c, d.source, d.expiryDays, now), status: 'unclaimed', note: d.note,
    ...(d.rank !== undefined ? { rank: d.rank } : {}),
  };
  b.box.push(e);
  emit?.({ name: 'gift_receive', s1: e.source, s2: e.titleKey, freeCoins: contents.freeCoins ?? 0, count: itemCount(contents), value: e.expiresAt === null ? 0 : Math.round((e.expiresAt - now) / DAY) });
  if ((c.pushSources ?? []).includes(d.source)) enqueuePush(m, s, GIFT_PUSH_TEMPLATE, {}, now); // REQ-BOX-011 (daily cap inside)
  return { status: 'boxed', giftId: e.id, expiresAt: e.expiresAt, duplicate: false };
}

function defaultTitle(src: GiftSource): GiftTitleKey { return src; }

/** REQ-BOX-007: full box → auto-claim the earliest-expiring non-compensation entry that fits; never drop anything. */
function makeRoom(m: Master, c: GiftBoxConfig, s: PlayerState, now: number, emit?: (e: KpiEvent) => void) {
  const b = ensureGiftBox(s);
  const order = sorted(b.box).filter((e) => e.source !== 'ops_compensation');
  for (const e of order) {
    if (holdReason(c, s, e.contents)) continue;
    claimEntry(s, e, 'overflow', now, emit);
    return;
  }
  const flag = 'gift_box_over_cap';
  const flags = (s.supportFlags ??= []);
  if (!flags.some((f) => f.startsWith(flag))) flags.push(`${flag}:${now}`);
}

/** Box order: soonest expiry first (no expiry last), then newest first. */
function sorted(box: GiftEntry[]): GiftEntry[] {
  return [...box].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

function holdReason(c: GiftBoxConfig, s: PlayerState, g: GiftContents): { reason: HoldReason; itemId?: string } | null {
  if ((g.freeCoins ?? 0) > 0 && s.wallet.free + g.freeCoins! > c.holdCaps.freeCoins) return { reason: 'coin_cap' };
  const add: Record<string, number> = {};
  for (const it of g.items ?? []) add[it.itemId] = (add[it.itemId] ?? 0) + it.qty;
  for (const [itemId, qty] of Object.entries(add)) if ((s.items[itemId] ?? 0) + qty > c.holdCaps.itemQty) return { reason: 'item_cap', itemId };
  return null;
}

function claimEntry(s: PlayerState, e: GiftEntry, how: 'one' | 'all' | 'overflow', now: number, emit?: (e: KpiEvent) => void) {
  const b = ensureGiftBox(s);
  if (e.contents.freeCoins) grantFree(s, e.contents.freeCoins, now, e.note, `gift:${e.id}`);
  if (e.contents.items?.length) addItems(s, e.contents.items);
  b.box = b.box.filter((x) => x.id !== e.id);
  const done: GiftEntry = { ...e, status: 'claimed', doneAt: now, how };
  delete done.held;
  b.history.push(done);
  emit?.({ name: 'gift_claim', s1: e.source, s2: how, freeCoins: e.contents.freeCoins ?? 0, count: itemCount(e.contents), value: Math.round((now - e.createdAt) / 3_600_000) });
}

/** REQ-BOX-006: entries past their expiry move to the history as expired; the history is pruned by age and size. */
export function expireGifts(m: Master, s: PlayerState, now: number, emit?: (e: KpiEvent) => void): number {
  const b = s.giftBox;
  if (!b) return 0;
  let n = 0;
  const keep: GiftEntry[] = [];
  for (const e of b.box) {
    if (e.expiresAt !== null && now >= e.expiresAt) {
      const done: GiftEntry = { ...e, status: 'expired', doneAt: e.expiresAt };
      delete done.held;
      b.history.push(done);
      emit?.({ name: 'gift_expire', s1: e.source, freeCoins: e.contents.freeCoins ?? 0, count: itemCount(e.contents) });
      n++;
    } else keep.push(e);
  }
  b.box = keep;
  const c = m.progression.giftBox;
  const days = c?.historyDays ?? 90;
  const max = c?.historyKeep ?? 300;
  b.history = b.history.filter((e) => (e.doneAt ?? e.createdAt) > now - days * DAY);
  if (b.history.length > max) b.history.splice(0, b.history.length - max);
  return n;
}

/** Something in the box has expired and is still listed as unclaimed (a read must write). */
export function giftsNeedExpiry(s: PlayerState, now: number): boolean {
  return (s.giftBox?.box ?? []).some((e) => e.expiresAt !== null && now >= e.expiresAt);
}

/** The player object's alarm: the earliest expiry in the box. */
export function nextGiftWake(s: PlayerState): number | null {
  const at = (s.giftBox?.box ?? []).map((e) => e.expiresAt).filter((x): x is number => x !== null);
  return at.length ? Math.min(...at) : null;
}

/** Home envelope badge (REQ-BOX-004): entries past expiry are not counted even before the expiry was written. */
export function giftBadge(m: Master, s: PlayerState, now: number) {
  const live = (s.giftBox?.box ?? []).filter((e) => e.expiresAt === null || now < e.expiresAt);
  const soon = (m.progression.giftBox?.expiringSoonDays ?? 3) * DAY;
  return { unclaimed: live.length, expiringSoon: live.filter((e) => e.expiresAt !== null && e.expiresAt - now <= soon).length };
}

const fmt = (n: number) => n.toLocaleString('en-US');
export const itemLabel = (m: Master, id: string) =>
  m.shopDisplay?.itemLabels[id] ?? m.items?.tickets[id]?.name ?? m.items?.cosmetics.find((c) => c.id === id)?.name ?? (m.items?.breedingMaterial.itemId === id ? '配合素材' : id);

/** What the player sees of an entry (never the internal ledger note or ref). */
export function giftView(m: Master, e: GiftEntry) {
  const items = (e.contents.items ?? []).map((x) => ({ itemId: x.itemId, name: itemLabel(m, x.itemId), qty: x.qty }));
  const lines = [...(e.contents.freeCoins ? [`無償コイン${fmt(e.contents.freeCoins)}枚`] : []), ...items.map((x) => `${x.name}×${x.qty}`)];
  return {
    giftId: e.id, source: e.source, titleKey: e.titleKey, title: GIFT_TITLES[e.titleKey] ?? GIFT_TITLES[e.source], rank: e.rank ?? null,
    contents: { freeCoins: e.contents.freeCoins ?? 0, items }, lines,
    createdAt: e.createdAt, expiresAt: e.expiresAt, status: e.status, doneAt: e.doneAt ?? null, how: e.how ?? null,
    held: e.held ? { reason: e.held.reason, itemId: e.held.itemId ?? null } : null,
  };
}

export function giftBoxView(m: Master, s: PlayerState, now: number, q: { tab: 'box' | 'history'; offset: number; limit: number }) {
  const c = m.progression.giftBox;
  const b = s.giftBox ?? { seq: 0, box: [], history: [] };
  const rows = q.tab === 'box'
    ? sorted(b.box.filter((e) => e.expiresAt === null || now < e.expiresAt))
    : [...b.history].reverse().sort((x, y) => (y.doneAt ?? 0) - (x.doneAt ?? 0)); // stable: the later move first
  const page = rows.slice(q.offset, q.offset + q.limit);
  return {
    enabled: !!c?.enabled, tab: q.tab, badge: giftBadge(m, s, now), maxUnclaimed: c?.maxUnclaimed ?? 0,
    total: rows.length, offset: q.offset, limit: q.limit, nextOffset: q.offset + q.limit < rows.length ? q.offset + q.limit : null,
    rules: { defaultExpiryDays: c?.expiryDays.default ?? null, historyDays: c?.historyDays ?? 90, paidCoins: false },
    entries: page.map((e) => giftView(m, e)),
  };
}

type ClaimOut = { giftId: string; source: GiftSource; freeCoins: number; items: ItemQty[] };
function claimResult(m: Master, s: PlayerState, now: number, claimed: GiftEntry[], held: { giftId: string; reason: HoldReason; itemId: string | null }[]) {
  const totals = { freeCoins: 0, items: {} as Record<string, number> };
  const touched = new Set<string>();
  const out: ClaimOut[] = claimed.map((e) => {
    totals.freeCoins += e.contents.freeCoins ?? 0;
    for (const it of e.contents.items ?? []) { totals.items[it.itemId] = (totals.items[it.itemId] ?? 0) + it.qty; touched.add(it.itemId); }
    return { giftId: e.id, source: e.source, freeCoins: e.contents.freeCoins ?? 0, items: e.contents.items ?? [] };
  });
  return {
    claimed: out, held, totals, badge: giftBadge(m, s, now),
    wallet: { paid: s.wallet.paid, free: s.wallet.free, total: s.wallet.paid + s.wallet.free, debt: s.wallet.debt },
    items: Object.fromEntries([...touched].map((k) => [k, s.items[k] ?? 0])),
  };
}

function claimable(s: PlayerState) {
  // REQ-BOX-009 (same rule as accountDeletion.deletionScheduled; inlined to keep the import graph acyclic)
  if (s.deletion?.status === 'scheduled' || s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
}

/** REQ-BOX-005: one entry, whole or not at all. */
export function claimGift(m: Master, s: PlayerState, giftId: string, now: number, emit?: (e: KpiEvent) => void) {
  claimable(s);
  const b = ensureGiftBox(s);
  const e = b.box.find((x) => x.id === giftId);
  if (!e) {
    const h = b.history.find((x) => x.id === giftId);
    if (h?.status === 'claimed') throw new AppError('ALREADY_CLAIMED', `${giftId} was already received`);
    if (h?.status === 'expired') throw new AppError('GIFT_EXPIRED', `${giftId} has expired`);
    throw new AppError('NOT_FOUND', `gift ${giftId}`);
  }
  const c = m.progression.giftBox ?? { holdCaps: { freeCoins: Number.MAX_SAFE_INTEGER, itemQty: Number.MAX_SAFE_INTEGER } } as GiftBoxConfig;
  const hold = holdReason(c, s, e.contents);
  if (hold) throw new AppError('GIFT_HOLD_CAP', hold.reason === 'coin_cap' ? `over the free coin limit ${c.holdCaps.freeCoins}` : `over the limit ${c.holdCaps.itemQty} of ${hold.itemId}`);
  claimEntry(s, e, 'one', now, emit);
  return claimResult(m, s, now, [e], []);
}

/** REQ-BOX-005: everything, soonest expiry first; an entry over a hold cap stays with its reason. */
export function claimAllGifts(m: Master, s: PlayerState, now: number, emit?: (e: KpiEvent) => void) {
  claimable(s);
  const b = ensureGiftBox(s);
  const c = m.progression.giftBox ?? { holdCaps: { freeCoins: Number.MAX_SAFE_INTEGER, itemQty: Number.MAX_SAFE_INTEGER } } as GiftBoxConfig;
  const claimed: GiftEntry[] = [];
  const held: { giftId: string; reason: HoldReason; itemId: string | null }[] = [];
  for (const e of sorted(b.box)) {
    const hold = holdReason(c, s, e.contents);
    if (hold) {
      const live = b.box.find((x) => x.id === e.id)!;
      live.held = { reason: hold.reason, ...(hold.itemId ? { itemId: hold.itemId } : {}), at: now };
      held.push({ giftId: e.id, reason: hold.reason, itemId: hold.itemId ?? null });
      continue;
    }
    claimEntry(s, e, 'all', now, emit);
    claimed.push(e);
  }
  return claimResult(m, s, now, claimed, held);
}

/** REQ-BOX-009: the deletion's finalize step gives up whatever is still in the box. */
export function forfeitGiftBox(s: PlayerState): { entries: number; freeCoins: number } {
  const b = s.giftBox;
  if (!b) return { entries: 0, freeCoins: 0 };
  const out = { entries: b.box.length, freeCoins: b.box.reduce((a, e) => a + (e.contents.freeCoins ?? 0), 0) };
  s.giftBox = { seq: b.seq, box: [], history: [] };
  return out;
}

/** Ops console (REQ-BOX-010): the whole box and the latest history, with the internal note. */
export function giftBoxSupportView(m: Master, s: PlayerState, now: number) {
  const b = s.giftBox ?? { seq: 0, box: [], history: [] };
  const row = (e: GiftEntry) => ({ ...giftView(m, e), ref: e.ref, note: e.note });
  return {
    enabled: !!m.progression.giftBox?.enabled, badge: giftBadge(m, s, now), maxUnclaimed: m.progression.giftBox?.maxUnclaimed ?? 0,
    box: sorted(b.box).map(row), history: [...b.history].reverse().slice(0, 50).map(row),
  };
}

/** A reward sink for pure domain steps (events, branches): the service passes `giftGiver`, tests may pass nothing (direct grant). */
export type Give = (r: Reward, note: string, ref: string, source: GiftSource, rank?: number | null) => void;
export const giftGiver = (m: Master, s: PlayerState, now: number, emit?: (e: KpiEvent) => void): Give =>
  (r, note, ref, source, rank) => { deliverGift(m, s, { source, ref, reward: r, note, ...(rank !== undefined ? { rank } : {}) }, now, emit); };
