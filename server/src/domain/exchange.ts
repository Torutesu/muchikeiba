import { z } from 'zod';
import { AppError } from './errors.js';
import { addItems, grantReward, logItem } from './items.js';
import { inviteRewardYen } from './invite.js';
import type { EventDef, EventExchange, ExchangeItemDef, Master } from './master.js';
import type { PlayerState } from './player.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, sameGameDay, type DayRule } from './time.js';
import { assetKeys } from './visuals.js';
import { grantFree } from './wallet.js';

/**
 * イベント交換所 REQ-EXCH-* (contracts/protocol.md §30). Pure logic over the player's state.
 *
 * - Event points are a per-event counter on the player (never an item, never a coin): they are earned only by
 *   racing that event (fixed points by finish place + participation, at most `dailyCap` per game day) and spent
 *   only in that event's exchange. No product, gacha, reward or ops grant can add them (the Reward type has no
 *   field for them and `eventPointSourceProblems` rejects any master/remote config that tries).
 * - Every exchange line has a fixed price, a fixed reward (coins / material / ticket / cosmetic / a named horse —
 *   nothing random) and a per-player stock for the event. There is no reward for taking every line (no コンプガチャ:
 *   the schema is strict, so a "complete the list" field cannot even be written).
 * - After the event ends the exchange stays open `graceDays` whole game days (04:00 JST rollover, REQ-DAY-001). Points
 *   left at the close become ceil(points / pointsPerUnit) of a standard material — shown before the close, never lost.
 */

export const EXCHANGE_HARD_LIMITS = {
  maxItems: 24, maxPrice: 100_000, maxStock: 99, minGraceDays: 1, maxGraceDays: 7, maxDailyCap: 5_000,
  maxPointsPerUnit: 1_000, maxQtyPerLine: 10,
  /** 景表法: one unit of a coin line ≤ 100 free coins (¥160 at the worst pack price) and every unit ≤ ¥200. */
  maxFreeCoinsPerUnit: 100, maxYenPerUnit: 200,
} as const;

const int = z.number().int();
const idRe = /^[a-z0-9_]{1,40}$/;
export const exchangeSchema = z.object({
  earn: z.object({ byPlace: z.array(int.min(0).max(1000)).min(1).max(12), participation: int.min(0).max(1000), dailyCap: int.min(1).max(EXCHANGE_HARD_LIMITS.maxDailyCap) }).strict(),
  graceDays: int.min(EXCHANGE_HARD_LIMITS.minGraceDays).max(EXCHANGE_HARD_LIMITS.maxGraceDays),
  leftover: z.object({ itemId: z.string().regex(idRe), pointsPerUnit: int.min(1).max(EXCHANGE_HARD_LIMITS.maxPointsPerUnit) }).strict(),
  items: z.array(z.object({
    id: z.string().regex(idRe), name: z.string().min(1).max(40),
    kind: z.enum(['coins', 'material', 'ticket', 'cosmetic', 'horse']),
    price: int.min(1).max(EXCHANGE_HARD_LIMITS.maxPrice), stock: int.min(1).max(EXCHANGE_HARD_LIMITS.maxStock),
    reward: z.object({
      freeCoins: int.min(1).max(EXCHANGE_HARD_LIMITS.maxFreeCoinsPerUnit).optional(),
      items: z.array(z.object({ itemId: z.string().regex(idRe), qty: int.min(1).max(EXCHANGE_HARD_LIMITS.maxQtyPerLine) }).strict()).length(1).optional(),
      horse: z.string().min(1).max(64).optional(),
    }).strict(),
  }).strict()).min(1).max(EXCHANGE_HARD_LIMITS.maxItems),
}).strict();

/** Per-event exchange state on the player. */
export interface PlayerExchangeState {
  /** Spendable points. */
  points: number;
  /** Lifetime earned / spent in this event (audit). */
  earned: number; spent: number;
  /** Game day of `today` and the points earned on it (daily cap). */
  day: string; today: number;
  /** Units taken per exchange line. */
  bought: Record<string, number>;
  /** Close + leftover rule as last seen (so the conversion still happens if the event is later removed from config). */
  rule: { closesAtMs: number; itemId: string; pointsPerUnit: number };
  /** Set once the leftover points were converted (idempotency). */
  converted: { at: number; points: number; itemId: string; qty: number } | null;
}

// ------------------------------------------------------------------------------------- schedule

/** REQ-EXCH-005: the instant the exchange closes = start of the game day `graceDays + 1` after the event's last game day. */
export function exchangeClosesAt(ev: Pick<EventDef, 'endAtMs'>, ex: Pick<EventExchange, 'graceDays'>, rule: DayRule): number {
  const lastDay = gameDayKey(ev.endAtMs - 1, rule);
  return gameDayStartMs(addJstDays(lastDay, ex.graceDays + 1), rule);
}

export type ExchangeStatus = 'upcoming' | 'open' | 'grace' | 'closed';
export function exchangeStatus(ev: EventDef, closesAtMs: number, now: number): ExchangeStatus {
  if (now < ev.startAtMs) return 'upcoming';
  if (now < ev.endAtMs) return 'open';
  if (now < closesAtMs) return 'grace';
  return 'closed';
}

/** Leftover conversion: rounds up, so even 1 point gives 1 unit (nothing is silently lost). */
export const leftoverQty = (points: number, pointsPerUnit: number) => (points > 0 ? Math.ceil(points / pointsPerUnit) : 0);

// ------------------------------------------------------------------------------------- validation

/** Items a ticket line may hand out: the gacha tickets (not SR+) and event-entry ticket items used as fees. */
function ticketIds(m: Pick<Master, 'items' | 'events'>, events: EventDef[]) {
  const ids = new Set(Object.entries(m.items?.tickets ?? {}).filter(([, t]) => t.kind !== 'srPlus').map(([id]) => id));
  for (const ev of events) if (ev.fee?.kind === 'item') ids.add(ev.fee.itemId);
  return ids;
}

/**
 * REQ-EXCH-002/003/007: the exchange of one event (boot, remote config staging and tests). Shape (strict: no random or
 * "take everything" fields), price/stock bounds, reward kind ↔ reward, coins ≤ the 景表法 ceiling, cosmetics that are
 * sold for any coin (never paid-only or product-only), a named horse inside its seasonal window, the leftover material.
 */
export function exchangeProblems(m: Pick<Master, 'items' | 'products' | 'gacha' | 'events' | 'progression'> & Partial<Pick<Master, 'templateById'>>, ev: EventDef, events: EventDef[] = [ev]): string[] {
  const at = `event ${ev.id}.exchange`;
  if (ev.exchange === undefined) return [];
  const parsed = exchangeSchema.safeParse(ev.exchange);
  if (!parsed.success) return parsed.error.issues.map((i) => `${at}.${i.path.join('.')}: ${i.message}`);
  const ex = ev.exchange;
  const p: string[] = [];
  const top = (ex.earn.byPlace[0] ?? 0) + ex.earn.participation;
  if (top <= 0) p.push(`${at}: a race must earn points`);
  if (ex.earn.dailyCap < top) p.push(`${at}: dailyCap must allow at least one winning race (${top})`);
  const material = m.items?.breedingMaterial.itemId;
  if (ex.leftover.itemId !== material) p.push(`${at}: leftover must convert into the standard material ${material}`);
  const tickets = ticketIds(m, events);
  const cosmetics = new Map((m.items?.cosmetics ?? []).map((c) => [c.id, c]));
  const ids = new Set<string>();
  const closesAt = exchangeClosesAt(ev, ex, dayRule(m));
  for (const it of ex.items) {
    const w = `${at} ${it.id}`;
    if (ids.has(it.id)) p.push(`${w}: duplicate id`);
    ids.add(it.id);
    const keys = Object.keys(it.reward).filter((k) => (it.reward as Record<string, unknown>)[k] !== undefined);
    if (keys.length !== 1) { p.push(`${w}: reward must be exactly one of freeCoins / items / horse`); continue; }
    const item = it.reward.items?.[0];
    switch (it.kind) {
      case 'coins': {
        if (!it.reward.freeCoins) { p.push(`${w}: a coins line gives freeCoins`); break; }
        const yen = inviteRewardYen(m, { freeCoins: it.reward.freeCoins });
        if (yen === null || yen > EXCHANGE_HARD_LIMITS.maxYenPerUnit) p.push(`${w}: ${it.reward.freeCoins} free coins exceed ¥${EXCHANGE_HARD_LIMITS.maxYenPerUnit} per unit`);
        break;
      }
      case 'material':
        if (!item || item.itemId !== material) p.push(`${w}: a material line gives ${material}`);
        break;
      case 'ticket': {
        if (!item || !tickets.has(item.itemId)) { p.push(`${w}: a ticket line gives a single gacha ticket or an event entry ticket`); break; }
        if (m.items?.tickets[item.itemId]) {
          const yen = inviteRewardYen(m, { items: [item] });
          if (yen === null || yen > EXCHANGE_HARD_LIMITS.maxYenPerUnit) p.push(`${w}: ticket value exceeds ¥${EXCHANGE_HARD_LIMITS.maxYenPerUnit} per unit`);
        }
        break;
      }
      case 'cosmetic': {
        const c = item ? cosmetics.get(item.itemId) : undefined;
        if (!c || item!.qty !== 1) { p.push(`${w}: a cosmetic line gives one known cosmetic`); break; }
        if (c.currency === 'paidOnly' || c.notForSale) p.push(`${w}: ${c.id} is paid-only or product-only and cannot be exchanged for free points`);
        if (it.stock !== 1) p.push(`${w}: a cosmetic line has stock 1`);
        break;
      }
      case 'horse': {
        if (!it.reward.horse) { p.push(`${w}: a horse line names a template`); break; }
        if (it.stock !== 1) p.push(`${w}: a horse line has stock 1`);
        const t = m.templateById?.get(it.reward.horse);
        if (m.templateById && !t) p.push(`${w}: unknown horse ${it.reward.horse}`);
        if (t?.seasonal && (ev.startAtMs < t.seasonal.startAtMs || closesAt > t.seasonal.endAtMs)) p.push(`${w}: seasonal horse ${t.id} outside its window (until the exchange closes)`);
        break;
      }
    }
  }
  return p;
}

const POINT_KEY_RE = /^(eventPoints?|exchangePoints?|event_points?)$/i;
const POINT_ITEM_RE = /^(event_?points?|ept_)/i;

/**
 * REQ-EXCH-003 (paid lint): event points can never be bought or come out of a paid gacha, a product, a pass or any other
 * reward. Walks products, gacha, progression (missions, passes, login, offers …) and every event reward for a key or an
 * item id that would name event points.
 */
export function eventPointSourceProblems(m: Pick<Master, 'products' | 'gacha' | 'progression' | 'events' | 'items'>): string[] {
  const p: string[] = [];
  const walk = (x: unknown, path: string) => {
    if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        if (POINT_KEY_RE.test(k)) p.push(`${path}.${k}: event points cannot be granted here (earned only by racing the event)`);
        if (k === 'itemId' && typeof v === 'string' && POINT_ITEM_RE.test(v)) p.push(`${path}.itemId: ${v} looks like event points; they are not an item`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(m.products, 'products');
  walk(m.gacha?.banners, 'gacha.banners');
  walk(m.progression, 'progression');
  walk(m.items?.cosmetics, 'items.cosmetics');
  for (const ev of m.events ?? []) {
    walk(ev.milestones, `event ${ev.id}.milestones`);
    walk(ev.rankRewards, `event ${ev.id}.rankRewards`);
    walk(ev.exchange?.items, `event ${ev.id}.exchange.items`);
  }
  return p;
}

// ------------------------------------------------------------------------------------- state

function syncRule(m: Pick<Master, 'progression'>, ev: EventDef, st: PlayerExchangeState) {
  const ex = ev.exchange!;
  st.rule = { closesAtMs: exchangeClosesAt(ev, ex, dayRule(m)), itemId: ex.leftover.itemId, pointsPerUnit: ex.leftover.pointsPerUnit };
}

export function ensureExchange(m: Pick<Master, 'progression'>, s: PlayerState, ev: EventDef): PlayerExchangeState {
  s.events ??= {};
  const e = (s.events[ev.id] ??= { points: 0, races: 0, wins: 0, milestones: [], pending: null, closed: false, rank: null });
  const st = (e.exchange ??= { points: 0, earned: 0, spent: 0, day: '', today: 0, bought: {}, rule: { closesAtMs: 0, itemId: '', pointsPerUnit: 1 }, converted: null });
  // a converted exchange keeps the rule it was converted under
  if (!st.converted) syncRule(m, ev, st);
  return st;
}

/** Today's earned points under the day rule (0 once the game day moved on). */
const earnedToday = (st: PlayerExchangeState, today: string) => (sameGameDay(st.day, today) ? st.today : 0);

/**
 * REQ-EXCH-004: points for one confirmed (non-void) event race. Fixed by place + participation, capped per game day.
 * The caller makes this idempotent per race id (PlayerService.applyRace). Returns null when the event has no exchange.
 */
export function earnExchangePoints(m: Pick<Master, 'progression'>, ev: EventDef, s: PlayerState, place: number, now: number) {
  const ex = ev.exchange;
  if (!ex) return null;
  const st = ensureExchange(m, s, ev);
  if (st.converted || now >= st.rule.closesAtMs) return { base: 0, gained: 0, capped: true, points: st.points, remainingToday: 0 };
  const today = gameDayKey(now, dayRule(m));
  const sofar = earnedToday(st, today);
  const base = (ex.earn.byPlace[place - 1] ?? 0) + ex.earn.participation;
  const gained = Math.max(0, Math.min(base, ex.earn.dailyCap - sofar));
  st.day = today;
  st.today = sofar + gained;
  st.points += gained;
  st.earned += gained;
  return { base, gained, capped: gained < base, points: st.points, remainingToday: ex.earn.dailyCap - st.today };
}

/** Owned cosmetics count once (the shop treats any positive count as owned). */
const owns = (s: PlayerState, itemId: string) => (s.items[itemId] ?? 0) > 0;

/**
 * REQ-EXCH-008: spends points on `qty` units of one line. Atomic (the caller runs it inside one PlayerService
 * transaction with the client's idempotency key): window, stock, points and ownership are checked before anything
 * moves. Each unit is granted on its own ledger ref, so a coin line never exceeds the per-grant ceiling.
 */
export function buyExchange(m: Pick<Master, 'progression'> & Partial<Pick<Master, 'templateById'>>, ev: EventDef, s: PlayerState, itemId: string, qty: number, now: number, ref: string) {
  const ex = ev.exchange;
  if (!ex) throw new AppError('NOT_FOUND', `event ${ev.id} has no exchange`);
  if (!Number.isInteger(qty) || qty < 1 || qty > EXCHANGE_HARD_LIMITS.maxStock) throw new AppError('BAD_REQUEST', 'qty must be a positive integer');
  const line = ex.items.find((x) => x.id === itemId);
  if (!line) throw new AppError('NOT_FOUND', `exchange item ${itemId}`);
  const st = ensureExchange(m, s, ev);
  const status = exchangeStatus(ev, st.rule.closesAtMs, now);
  if (status === 'upcoming') throw new AppError('EXCHANGE_NOT_OPEN');
  if (status === 'closed' || st.converted) throw new AppError('EXCHANGE_CLOSED');
  const bought = st.bought[line.id] ?? 0;
  if (bought + qty > line.stock) throw new AppError('OUT_OF_STOCK', `${line.id}: ${line.stock - bought} left`);
  const ownedItem = line.kind === 'cosmetic' ? line.reward.items![0]!.itemId : null;
  if (ownedItem && owns(s, ownedItem)) throw new AppError('ALREADY_PURCHASED', `${ownedItem} is already owned`);
  const cost = line.price * qty;
  if (st.points < cost) throw new AppError('INSUFFICIENT_POINTS', `need ${cost} points, have ${st.points}`);
  st.points -= cost;
  st.spent += cost;
  st.bought[line.id] = bought + qty;
  for (let i = 0; i < qty; i++) {
    const unitRef = `${ref}:${bought + i + 1}`;
    const reason = `exchange ${ev.id} ${line.id}`;
    if (line.reward.freeCoins) grantFree(s, line.reward.freeCoins, now, reason, unitRef);
    else if (line.reward.items) {
      addItems(s, line.reward.items);
      for (const it of line.reward.items) logItem(s, now, it.itemId, it.qty, reason, unitRef);
    } else grantReward(s, { horse: line.reward.horse }, now, reason, unitRef, m as Pick<Master, 'templateById'>);
  }
  return {
    eventId: ev.id, itemId: line.id, kind: line.kind, qty, spent: cost, points: st.points,
    bought: st.bought[line.id]!, remaining: Math.max(0, line.stock - st.bought[line.id]!),
    granted: { freeCoins: (line.reward.freeCoins ?? 0) * qty, items: (line.reward.items ?? []).map((x) => ({ itemId: x.itemId, qty: x.qty * qty })), horse: line.reward.horse ?? null },
  };
}

/**
 * REQ-EXCH-006: converts the points left in every exchange whose close has passed (once each; runs at the start of
 * every player transaction, like the pity conversion). Uses the current definition when the event still exists,
 * otherwise the rule stored with the points, so nothing is lost if the event is removed from config.
 */
export function settleExchanges(m: Pick<Master, 'events' | 'progression'>, s: PlayerState, now: number) {
  const out: { eventId: string; points: number; itemId: string; qty: number }[] = [];
  for (const [eventId, e] of Object.entries(s.events ?? {})) {
    const st = e.exchange;
    if (!st || st.converted) continue;
    const ev = m.events.find((x) => x.id === eventId);
    if (ev?.exchange) syncRule(m, ev, st);
    if (now < st.rule.closesAtMs) continue;
    const qty = leftoverQty(st.points, st.rule.pointsPerUnit);
    if (qty > 0) {
      addItems(s, [{ itemId: st.rule.itemId, qty }]);
      logItem(s, now, st.rule.itemId, qty, `exchange ${eventId} leftover ${st.points}pt`, `exch:${eventId}:leftover`);
    }
    st.converted = { at: now, points: st.points, itemId: st.rule.itemId, qty };
    out.push({ eventId, points: st.points, itemId: st.rule.itemId, qty });
    st.points = 0;
  }
  return out;
}

// ------------------------------------------------------------------------------------- views

function lineView(s: PlayerState, line: ExchangeItemDef, st: PlayerExchangeState | undefined, points: number) {
  const bought = st?.bought[line.id] ?? 0;
  const itemId = line.reward.items?.[0]?.itemId ?? null;
  const owned = line.kind === 'cosmetic' && itemId ? owns(s, itemId) : false;
  // a remote-config change may lower a stock below what was already taken: never show a negative stock
  const remaining = Math.max(0, line.stock - bought);
  return {
    id: line.id, name: line.name, kind: line.kind, price: line.price, stock: line.stock, bought, remaining, owned,
    reward: line.reward,
    /** Item art; coins and horses use the client's coin icon / the horse's own appearance (portrait). */
    icon: itemId ? assetKeys.item(itemId) : line.kind === 'horse' ? assetKeys.collectionPortrait(line.reward.horse!) : null,
    affordable: remaining > 0 && !owned && points >= line.price,
    maxQty: owned ? 0 : Math.max(0, Math.min(remaining, Math.floor(points / line.price))),
  };
}

/** REQ-EXCH-009: GET /v1/events/:eventId/exchange. Every time is a real instant from the definition (no fake timers). */
export function exchangeView(m: Pick<Master, 'progression'>, ev: EventDef, s: PlayerState, now: number) {
  const ex = ev.exchange;
  if (!ex) throw new AppError('NOT_FOUND', `event ${ev.id} has no exchange`);
  const rule = dayRule(m);
  const st = s.events?.[ev.id]?.exchange;
  const closesAtMs = st?.converted ? st.rule.closesAtMs : exchangeClosesAt(ev, ex, rule);
  const status = exchangeStatus(ev, closesAtMs, now);
  const today = gameDayKey(now, rule);
  const points = st?.points ?? 0;
  const todayEarned = st ? earnedToday(st, today) : 0;
  return {
    eventId: ev.id, name: ev.name, status, startAtMs: ev.startAtMs, endAtMs: ev.endAtMs, closesAtMs, graceDays: ex.graceDays,
    points, earned: st?.earned ?? 0, spent: st?.spent ?? 0,
    earn: {
      byPlace: ex.earn.byPlace, participation: ex.earn.participation, dailyCap: ex.earn.dailyCap,
      earnedToday: todayEarned, remainingToday: status === 'open' ? ex.earn.dailyCap - todayEarned : 0,
      resetsAtMs: gameDayStartMs(addJstDays(today, 1), rule),
    },
    leftover: {
      itemId: ex.leftover.itemId, pointsPerUnit: ex.leftover.pointsPerUnit, rounding: 'up' as const,
      preview: leftoverQty(points, ex.leftover.pointsPerUnit), converted: st?.converted ?? null,
    },
    items: ex.items.map((line) => lineView(s, line, st, status === 'closed' ? 0 : points)),
    rules: { purchasable: false, random: false, completionReward: false, sources: ['event_race'] as const },
  };
}

/** Small summary for the event list (GET /v1/events): the point counter on the event top. */
export function exchangeSummary(m: Pick<Master, 'progression'>, ev: EventDef, s: PlayerState, now: number) {
  if (!ev.exchange) return null;
  const st = s.events?.[ev.id]?.exchange;
  const closesAtMs = st?.converted ? st.rule.closesAtMs : exchangeClosesAt(ev, ev.exchange, dayRule(m));
  return { status: exchangeStatus(ev, closesAtMs, now), closesAtMs, graceDays: ev.exchange.graceDays, points: st?.points ?? 0, leftover: ev.exchange.leftover, converted: st?.converted ?? null };
}
