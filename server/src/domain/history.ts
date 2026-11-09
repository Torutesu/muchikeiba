/**
 * 購入履歴・コイン履歴・ガチャ履歴 (REQ-HIST-001..014, contracts/protocol.md §33). Read-only views over records the
 * player state already keeps (purchases, the wallet ledger) plus the gacha record added here (`gachaLog`).
 *
 * Rules the views keep:
 *  - paid and free coins are never mixed (資金決済法): the coin list is filtered per currency, the header splits them;
 *  - no internal id in a text: store transaction ids, product / banner ids and the ledger's reason strings (which can
 *    name an operator) never reach `title` / `detail`. Rows are pointed at with a support reference `ref`;
 *  - Japanese is the source text; English is applied at the response boundary (i18n/en.ts CODE_EN).
 */
import { AppError } from './errors.js';
import type { Master, Rarity } from './master.js';
import type { Currency, LedgerEntry, PlayerState, PurchaseRecord } from './player.js';
import { ageBand } from './purchase.js';
import { DAY_MS, jstMonthKey } from './time.js';
import { deletionConfig } from './accountDeletion.js';

/** Windows and caps (REQ-HIST-003/004/005/013). */
export const HISTORY_LIMITS = {
  coinDays: 365,
  gachaDays: 90,
  /** Gacha records kept inside the state (memory repos / the prototype); the Durable Object moves older ones to SQL. */
  gachaKeep: 300,
  pageDefault: 20,
  pageMax: 50,
  ticketRefsMax: 10,
} as const;

export interface GachaLogEntry {
  seq: number; at: number;
  /** null: a ticket that is not tied to a banner (SR+ ticket). */
  bannerId: string | null;
  via: 'coins' | 'ticket' | 'tutorial';
  itemId?: string;
  count: number;
  paid: number; free: number;
  results: { templateId: string; rarity: Rarity; duplicate: boolean }[];
}
export interface GachaLogState { seq: number; entries: GachaLogEntry[] }

/** REQ-HIST-004/013: one record per draw (coins, ticket or the tutorial); records past 90 days or the cap are dropped. */
export function recordGachaLog(s: PlayerState, now: number, e: Omit<GachaLogEntry, 'seq' | 'at'>): GachaLogEntry {
  const log = (s.gachaLog ??= { seq: 0, entries: [] });
  log.seq += 1;
  const entry: GachaLogEntry = { seq: log.seq, at: now, ...e, results: e.results.map((r) => ({ templateId: r.templateId, rarity: r.rarity, duplicate: r.duplicate })) };
  log.entries.push(entry);
  const cutoff = now - HISTORY_LIMITS.gachaDays * DAY_MS;
  log.entries = log.entries.filter((x) => x.at > cutoff);
  if (log.entries.length > HISTORY_LIMITS.gachaKeep) log.entries.splice(0, log.entries.length - HISTORY_LIMITS.gachaKeep);
  return entry;
}

// ----------------------------------------------------------------------------- references and cursors

/** FNV-1a 32-bit, 8 upper-case hex digits: the purchase reference never shows the store transaction id. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).toUpperCase().padStart(8, '0');
}
export const purchaseRef = (txId: string) => `P-${fnv(txId)}`;
export const coinRef = (seq: number) => `C-${seq}`;
export const gachaRef = (seq: number) => `G-${seq}`;
export const REF_RE = /^(P-[0-9A-F]{8}|C-[1-9][0-9]{0,11}|G-[1-9][0-9]{0,11})$/;

export type HistoryKind = 'purchases' | 'coins' | 'gacha';
const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
/** Opaque to clients ("pass back nextCursor as is"); the position is a sequence (coins, gacha) or a purchase index. */
export function encodeCursor(kind: HistoryKind, before: number): string { return b64(`h1:${kind}:${before}`); }
export function decodeCursor(kind: HistoryKind, cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  let raw = '';
  try { raw = unb64(cursor); } catch { throw new AppError('BAD_REQUEST', 'bad cursor'); }
  const m = /^h1:([a-z]+):(\d{1,12})$/.exec(raw);
  if (!m || m[1] !== kind) throw new AppError('BAD_REQUEST', 'bad cursor');
  return Number(m[2]);
}
/** REQ-HIST-005: `cursor`, `limit` (1..50) and, for coins, `currency` (paid | free). Anything else in them is a 400. */
export function historyQuery(q: URLSearchParams, kind: string): { cursor: string | null; limit: number | null; currency: Currency | null } {
  const lim = q.get('limit');
  if (lim !== null && !/^\d{1,3}$/.test(lim)) throw new AppError('BAD_REQUEST', 'limit must be an integer');
  const cur = q.get('currency');
  if (cur !== null && (kind !== 'coins' || (cur !== 'paid' && cur !== 'free'))) throw new AppError('BAD_REQUEST', 'currency must be paid or free (coins only)');
  const cursor = q.get('cursor');
  if (cursor !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) throw new AppError('BAD_REQUEST', 'bad cursor');
  return { cursor, limit: lim === null ? null : Number(lim), currency: (cur as 'paid' | 'free' | null) ?? null };
}

export function pageLimit(v: number | null | undefined): number {
  if (v === null || v === undefined) return HISTORY_LIMITS.pageDefault;
  if (!Number.isInteger(v) || v < 1 || v > HISTORY_LIMITS.pageMax) throw new AppError('BAD_REQUEST', `limit must be 1..${HISTORY_LIMITS.pageMax}`);
  return v;
}

// ----------------------------------------------------------------------------- texts

const fmtInt = (n: number) => n.toLocaleString('en-US');
const named = (base: string, name: string | null | undefined) => (name ? `${base}（${name}）` : base);
const productName = (m: Master, id: string) => m.products.find((p) => p.id === id)?.name ?? null;
const bannerName = (m: Master, id: string) => m.gacha.banners.find((b) => b.id === id)?.name ?? null;
const itemName = (m: Master, id: string) => m.shopDisplay?.itemLabels[id] ?? m.items.tickets[id]?.name ?? m.items.cosmetics.find((c) => c.id === id)?.name ?? null;

export const STORE_NAMES: Record<PurchaseRecord['platform'], string> = { apple: 'App Store', google: 'Google Play', fake: 'テスト' };
export type PurchaseStatus = 'completed' | 'refunded' | 'pending' | 'test';
export const PURCHASE_STATUS_TEXT: Record<PurchaseStatus, string> = {
  completed: '購入済み',
  refunded: '返金済み',
  pending: '確認中（ストアの支払い待ち）',
  test: 'テスト購入（請求なし）',
};
export const HISTORY_NOTICE = '有償コインに有効期限はありません。使うときは有償コインから先に使われます。無償コインはゲーム内で受け取ったコインです。';
export const PENDING_STORE_NOTE = 'ストアで保留中の購入は、支払いが終わるとここに表示されます。';

export type CoinCategory =
  | 'purchase' | 'purchase_bonus' | 'purchase_test' | 'daily_pack' | 'gacha' | 'shop' | 'ad_reward' | 'compensation' | 'login' | 'mission'
  | 'achievement' | 'race' | 'time_attack' | 'pass' | 'season' | 'team' | 'event_fee' | 'event_fee_refund' | 'event' | 'tournament'
  | 'stud' | 'invite' | 'bond' | 'comeback' | 'refund' | 'debt' | 'debt_settle' | 'forfeit'
  | 'rival' | 'team_goal' | 'weekly_challenge' | 'exchange' | 'other';

export const COIN_TITLES: Record<CoinCategory, string> = {
  purchase: 'コインの購入', purchase_bonus: 'はじめての購入の特典', purchase_test: 'テスト購入', daily_pack: '毎日の受け取り',
  gacha: 'スカウト', shop: 'ショップで購入', ad_reward: '動画広告の視聴', compensation: '運営からのお詫び・補填', login: 'ログインボーナス',
  mission: 'ミッションの報酬', achievement: '実績の報酬', race: 'レースの報酬', time_attack: 'タイムアタックの報酬', pass: 'シーズンパスの報酬',
  season: 'シーズンの報酬', team: '支部の報酬', event_fee: 'イベントの参加費', event_fee_refund: 'イベントの参加費の返却', event: 'イベントの報酬',
  tournament: '大会の報酬', stud: '種付け料', invite: '友達招待の報酬', bond: '絆レベルの報酬', comeback: '復帰キャンペーンの報酬',
  refund: 'ストアの返金による回収', debt: '未精算の返金', debt_settle: '返金の精算', forfeit: 'アカウント削除による放棄',
  rival: 'ライバルの週の報酬', team_goal: '支部の共同目標の報酬', weekly_challenge: '週替わりチャレンジの報酬', exchange: 'イベント交換所', other: 'その他の増減',
};

/**
 * The ledger's reason strings are written by the domain code (wallet.ts callers); this maps them to a category and a
 * player-facing title. Unknown reasons are `other` — never the raw reason (it may hold an operator's name or ids).
 */
export function classifyLedger(m: Master, e: Pick<LedgerEntry, 'reason' | 'kind' | 'delta'>): { category: CoinCategory; title: string } {
  const r = e.reason;
  let x: RegExpExecArray | null;
  const c = (category: CoinCategory, title: string = COIN_TITLES[category]) => ({ category, title });
  if ((x = /^purchase (\S+)$/.exec(r))) return c('purchase', named(COIN_TITLES.purchase, productName(m, x[1]!)));
  if ((x = /^first purchase bonus (\S+)$/.exec(r))) return c('purchase_bonus', named(COIN_TITLES.purchase_bonus, productName(m, x[1]!)));
  if ((x = /^sandbox purchase (\S+)$/.exec(r))) return c('purchase_test', named(COIN_TITLES.purchase_test, productName(m, x[1]!)));
  if ((x = /^daily pack (\S+)/.exec(r))) return c('daily_pack', named(COIN_TITLES.daily_pack, productName(m, x[1]!)));
  if ((x = /^gacha (\S+) x(\d+)/.exec(r))) return c('gacha', named(`スカウト${x[2]}回`, bannerName(m, x[1]!)));
  if ((x = /^cosmetic (\S+)$/.exec(r))) return c('shop', named(COIN_TITLES.shop, itemName(m, x[1]!)));
  if (r.startsWith('rewarded ad ')) return c('ad_reward');
  if (r.startsWith('support grant')) return c('compensation');
  if (r.startsWith('comeback ')) return c('comeback');
  if (/^(beginner )?login bonus/.test(r)) return c('login');
  if (/^(beginner |season )?mission /.test(r)) return c('mission');
  if (r.startsWith('achievement ')) return c('achievement');
  if (r.startsWith('race ') || r.startsWith('first win bonus')) return c('race');
  if (r.startsWith('time attack')) return c('time_attack');
  if (r.startsWith('pass ')) return c('pass');
  if (r.startsWith('season ')) return c('season');
  if (r.startsWith('team goal ')) return c('team_goal'); // §32 (paid through the gift box: the claim keeps this note)
  if (r.startsWith('team ') || r.startsWith('league ')) return c('team');
  if (r.startsWith('rival week ')) return c('rival'); // §28
  if (r.startsWith('weekly challenge ')) return c('weekly_challenge'); // §31
  if (r.startsWith('exchange ')) return c('exchange'); // §30 (coin lines; the leftover is material, not coins)
  if (r === 'event entry fee refund') return c('event_fee_refund');
  if (r === 'event entry fee') return c('event_fee');
  if (r.startsWith('event ')) return c('event');
  if (r.startsWith('tournament ')) return c('tournament');
  if (r === 'stud fee') return c('stud', e.delta < 0 ? '種付け料の支払い' : '種付け料の受け取り');
  if (r.startsWith('invite ')) return c('invite');
  if (r.startsWith('bond level')) return c('bond');
  if (r.startsWith('store refund')) return c('refund');
  if ((x = /^unsettled (?:bonus )?refund (\d+)$/.exec(r))) return c('debt', `未精算の返金（${x[1]}枚）`);
  if (r === 'debt settlement' || r.startsWith('debt write-off')) return c('debt_settle');
  if (r === 'account deleted') return c('forfeit');
  return c('other');
}

// ----------------------------------------------------------------------------- rows

function purchaseStatus(s: PlayerState, p: PurchaseRecord): PurchaseStatus {
  if (p.refunded) return 'refunded';
  if (p.sandbox) return 'test';
  const sub = p.originalTxId ? s.storeSubscriptions?.[p.originalTxId] : undefined;
  if (sub && (sub.status === 'grace' || sub.status === 'billing_retry')) return 'pending';
  return 'completed';
}

export function purchaseRow(m: Master, s: PlayerState, p: PurchaseRecord, internal = false) {
  const status = purchaseStatus(s, p);
  return {
    ref: purchaseRef(p.txId), at: p.at, product: productName(m, p.productId) ?? '購入した商品', productId: p.productId, priceYen: p.priceYen,
    store: p.platform, storeName: STORE_NAMES[p.platform], status, statusText: PURCHASE_STATUS_TEXT[status],
    paidCoins: p.paidCoinsGranted, bonusCoins: p.bonusCoinsGranted, bonusPaid: !!p.bonusLotId,
    ...(internal ? { internal: { txId: p.txId, platform: p.platform, limitBreach: p.limitBreach, sandbox: !!p.sandbox, month: p.month ?? jstMonthKey(p.at) } } : {}),
  };
}
export type PurchaseRow = ReturnType<typeof purchaseRow>;

export function coinRow(m: Master, s: PlayerState, e: LedgerEntry, internal = false) {
  const { category, title } = classifyLedger(m, e);
  const linked = (category === 'purchase' || category === 'purchase_bonus' || category === 'purchase_test' || category === 'refund' || category === 'debt' || category === 'debt_settle')
    && s.purchases.some((p) => p.txId === e.ref);
  return {
    ref: coinRef(e.seq), at: e.at, currency: e.currency, direction: e.delta > 0 ? 'earned' as const : e.delta < 0 ? 'spent' as const : 'note' as const,
    amount: Math.abs(e.delta), balanceAfter: e.balanceAfter, category, title,
    ...(linked ? { purchaseRef: purchaseRef(e.ref) } : {}),
    ...(internal ? { internal: { kind: e.kind, reason: e.reason, ref: e.ref } } : {}),
  };
}
export type CoinRow = ReturnType<typeof coinRow>;

const VIA_TEXT = { coins: 'コイン', tutorial: 'チュートリアル（無料）' } as const;
export function gachaRow(m: Master, e: GachaLogEntry) {
  const tpl = (id: string) => m.templateById.get(id);
  const counts: Record<string, number> = {};
  for (const r of e.results) counts[r.rarity] = (counts[r.rarity] ?? 0) + 1;
  const summary = (['SSR', 'SR', 'R', 'N'] as const).filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join('・');
  const ticket = e.itemId ? itemName(m, e.itemId) : null;
  const banner = e.bannerId ? bannerName(m, e.bannerId) : null;
  return {
    ref: gachaRef(e.seq), at: e.at, banner: banner ?? ticket ?? 'スカウト', bannerId: e.bannerId, via: e.via,
    viaText: e.via === 'ticket' ? ticket ?? 'スカウト券' : VIA_TEXT[e.via], count: e.count, coins: { paid: e.paid, free: e.free },
    results: e.results.map((r) => ({ templateId: r.templateId, name: tpl(r.templateId)?.name ?? '？？？', rarity: r.rarity, duplicate: r.duplicate })),
    summary,
  };
}
export type GachaRow = ReturnType<typeof gachaRow>;

// ----------------------------------------------------------------------------- views

export const windows = (m: Master) => ({ purchasesDays: deletionConfig(m).ledgerRetentionDays, coinsDays: HISTORY_LIMITS.coinDays, gachaDays: HISTORY_LIMITS.gachaDays });

/** REQ-HIST-001: balances (paid / free apart) and this month's spend against the age band's limit. */
export function historySummary(m: Master, s: PlayerState, now: number) {
  const month = jstMonthKey(now);
  const spent = s.monthlySpendYen[month] ?? 0;
  const limit = ageBand(m, s, now)?.band.monthlyLimitYen ?? null;
  return {
    wallet: { paid: s.wallet.paid, free: s.wallet.free, total: s.wallet.paid + s.wallet.free, debt: s.wallet.debt },
    month, monthSpentYen: spent, monthlyLimitYen: limit, remainingYen: limit === null ? null : Math.max(0, limit - spent), ageLimited: limit !== null,
    limitText: limit === null ? null : `今月の購入 ¥${fmtInt(spent)} ／ 上限 ¥${fmtInt(limit)}（年齢に応じた月額上限）`,
    notice: HISTORY_NOTICE,
    windows: windows(m),
  };
}

export interface Page<T> { items: T[]; nextCursor: string | null; windowDays: number }

/** REQ-HIST-002: purchases inside the legal retention period, newest first; the cursor is a position in the append-only list. */
export function purchaseHistory(m: Master, s: PlayerState, now: number, cursor: string | null, limit: number, internal = false): Page<PurchaseRow> & { note: string } {
  const before = decodeCursor('purchases', cursor);
  const days = deletionConfig(m).ledgerRetentionDays;
  const since = now - days * DAY_MS;
  const items: PurchaseRow[] = [];
  let next: string | null = null;
  for (let i = Math.min(before ?? s.purchases.length, s.purchases.length) - 1; i >= 0; i--) {
    const p = s.purchases[i]!;
    if (p.at <= since) continue;
    if (items.length === limit) { next = encodeCursor('purchases', i + 1); break; }
    items.push(purchaseRow(m, s, p, internal));
  }
  return { items, nextCursor: next, windowDays: days, note: PENDING_STORE_NOTE };
}

/** A page of ledger rows (newest first, seq < beforeSeq, at > sinceAt). The Durable Object reads its SQL table. */
export type LedgerPager = (q: { beforeSeq: number | null; sinceAt: number; limit: number; currency: Currency | null }) => LedgerEntry[] | Promise<LedgerEntry[]>;
export const stateLedgerPager = (s: PlayerState): LedgerPager => (q) =>
  s.ledger.filter((e) => (q.beforeSeq === null || e.seq < q.beforeSeq) && e.at > q.sinceAt && (q.currency === null || e.currency === q.currency))
    .sort((a, b) => b.seq - a.seq).slice(0, q.limit);

/** REQ-HIST-003: the ledger of the last 365 days, one currency at a time (or both), newest first. */
export async function coinHistory(m: Master, s: PlayerState, pager: LedgerPager, now: number, currency: Currency | null, cursor: string | null, limit: number, internal = false): Promise<Page<CoinRow> & { currency: Currency | null }> {
  const before = decodeCursor('coins', cursor);
  const rows = await pager({ beforeSeq: before, sinceAt: now - HISTORY_LIMITS.coinDays * DAY_MS, limit: limit + 1, currency });
  const page = rows.slice(0, limit);
  return {
    items: page.map((e) => coinRow(m, s, e, internal)), currency,
    nextCursor: rows.length > limit ? encodeCursor('coins', page[page.length - 1]!.seq) : null, windowDays: HISTORY_LIMITS.coinDays,
  };
}

export type GachaPager = (q: { beforeSeq: number | null; sinceAt: number; limit: number }) => GachaLogEntry[] | Promise<GachaLogEntry[]>;
export const stateGachaPager = (s: PlayerState): GachaPager => (q) =>
  (s.gachaLog?.entries ?? []).filter((e) => (q.beforeSeq === null || e.seq < q.beforeSeq) && e.at > q.sinceAt).sort((a, b) => b.seq - a.seq).slice(0, q.limit);

/** REQ-HIST-004: draws of the last 90 days, newest first. */
export async function gachaHistory(m: Master, pager: GachaPager, now: number, cursor: string | null, limit: number): Promise<Page<GachaRow>> {
  const before = decodeCursor('gacha', cursor);
  const rows = await pager({ beforeSeq: before, sinceAt: now - HISTORY_LIMITS.gachaDays * DAY_MS, limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map((e) => gachaRow(m, e)), nextCursor: rows.length > limit ? encodeCursor('gacha', page[page.length - 1]!.seq) : null, windowDays: HISTORY_LIMITS.gachaDays };
}

export type ResolvedRef =
  | { ref: string; kind: 'purchase'; row: PurchaseRow }
  | { ref: string; kind: 'coin'; row: CoinRow }
  | { ref: string; kind: 'gacha'; row: GachaRow };

/**
 * REQ-HIST-009/010: the rows behind support references, only inside the same windows as the lists (an older or
 * someone else's reference is simply not found). `internal` adds the ops-only values (admin API).
 */
export async function resolveRefs(m: Master, s: PlayerState, ledger: LedgerPager, gacha: GachaPager, now: number, refs: string[], internal = false): Promise<(ResolvedRef | { ref: string; kind: null; row: null })[]> {
  const out: (ResolvedRef | { ref: string; kind: null; row: null })[] = [];
  const purchaseSince = now - deletionConfig(m).ledgerRetentionDays * DAY_MS;
  for (const ref of refs) {
    if (!REF_RE.test(ref)) throw new AppError('BAD_REQUEST', 'bad reference');
    const n = Number(ref.slice(2));
    if (ref.startsWith('P-')) {
      const p = [...s.purchases].reverse().find((x) => x.at > purchaseSince && purchaseRef(x.txId) === ref);
      out.push(p ? { ref, kind: 'purchase', row: purchaseRow(m, s, p, internal) } : { ref, kind: null, row: null });
    } else if (ref.startsWith('C-')) {
      const e = (await ledger({ beforeSeq: n + 1, sinceAt: now - HISTORY_LIMITS.coinDays * DAY_MS, limit: 1, currency: null }))[0];
      out.push(e && e.seq === n ? { ref, kind: 'coin', row: coinRow(m, s, e, internal) } : { ref, kind: null, row: null });
    } else {
      const e = (await gacha({ beforeSeq: n + 1, sinceAt: now - HISTORY_LIMITS.gachaDays * DAY_MS, limit: 1 }))[0];
      out.push(e && e.seq === n ? { ref, kind: 'gacha', row: gachaRow(m, e) } : { ref, kind: null, row: null });
    }
  }
  return out;
}

export const SUPPORT_TOPICS = ['purchase_missing', 'refund', 'coins', 'gacha', 'other'] as const;
export type SupportTopic = typeof SUPPORT_TOPICS[number];
export const SUPPORT_TOPIC_TEXT: Record<SupportTopic, string> = {
  purchase_missing: '購入したのに届かない', refund: '返金について', coins: 'コインの増減について', gacha: 'スカウトの結果について', other: 'その他の問い合わせ',
};

/** One line per referenced row for the ticket (what the player selected, without internal ids). */
export function ticketDetail(r: ResolvedRef): { title: string; detail: string } {
  if (r.kind === 'purchase') return { title: r.row.product, detail: `¥${fmtInt(r.row.priceYen)}・${r.row.storeName}・${r.row.statusText}` };
  if (r.kind === 'coin') {
    const cur = r.row.currency === 'paid' ? '有償コイン' : '無償コイン';
    const dir = r.row.direction === 'earned' ? '獲得' : r.row.direction === 'spent' ? '使用' : '記録';
    return { title: r.row.title, detail: `${cur}${fmtInt(r.row.amount)}枚・${dir}` };
  }
  return { title: r.row.banner, detail: `スカウト${r.row.count}回・${r.row.summary}` };
}
