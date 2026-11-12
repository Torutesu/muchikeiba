/**
 * Quality pass 2 (docs/quality/shop.md §3.1): the scout confirmation — every way this player can pull on a banner right
 * now, each with exactly what it takes (paid / free coins, in the order the wallet spends them, or a ticket) and what is
 * left after. Read only (GET /v1/gacha/:bannerId/options); the pull itself still goes through drawGacha / useTicket, which
 * decide again on the transaction (this view never grants or reserves anything).
 *
 * Why: before this, 「10回引く」 spent 1,000 coins in one tap with no word of which coins, and the tickets the game hands
 * out (login bonus, missions, the starter pack's SR+ ticket) had no button anywhere in the scout screen.
 *
 * Legal guard rails (docs/planning/03, 06 §5.5): paid and free are always named separately and paid goes first
 * (REQ-WAL-002); a paid-only banner counts paid coins only; tickets never draw a paid-only or step-up banner (REQ-ITEM-001,
 * REQ-GACHA-014); no 「倍」, no urgency — the only time is the banner's real end (the banner list carries it).
 */
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { bannerStatus, findVisibleBanner, gachaPrice, stepIndex } from './gacha.js';

const fmt = (n: number) => n.toLocaleString('en-US');

export interface CoinSplit { paid: number; free: number }

/** What `spend` (wallet.ts) would take for `amount`: paid first, then free; paid-only takes paid only. Null when short. */
export function spendSplit(w: CoinSplit, amount: number, paidOnly: boolean): CoinSplit | null {
  const available = paidOnly ? w.paid : w.paid + w.free;
  if (available < amount) return null;
  const paid = Math.min(w.paid, amount);
  return { paid, free: amount - paid };
}

/** 「有償コイン300枚と無償コイン700枚を使います」 — both kinds named, zero parts left out, paid first. */
export function spendLine(sp: CoinSplit): string {
  if (sp.paid > 0 && sp.free > 0) return `有償コイン${fmt(sp.paid)}枚と無償コイン${fmt(sp.free)}枚を使います`;
  if (sp.paid > 0) return `有償コイン${fmt(sp.paid)}枚を使います`;
  return `無償コイン${fmt(sp.free)}枚を使います`;
}

export type ScoutBlock = 'short' | 'closed' | 'upcoming' | 'debt' | null;

export interface ScoutWay {
  /** `coins_1` / `coins_10` / `ticket:<itemId>` — the client sends nothing of this back; it calls draw or ticket use. */
  id: string;
  via: 'coins' | 'ticket';
  count: 1 | 10;
  itemId: string | null;
  label: string;
  /** coins: the price of this pull for this player (a step-up banner: its current step). */
  price: number | null;
  /** coins: exactly what it takes (paid first) — null when short. */
  pays: CoinSplit | null;
  /** coins: the wallet after the pull. */
  after: CoinSplit | null;
  /** tickets: how many the player holds. */
  owned: number | null;
  available: boolean;
  block: ScoutBlock;
  /** coins short: how many are missing (the shortfall sheet, protocol §29, takes it from there). */
  shortfall: number | null;
  /** The one line the confirmation shows (server-built, paid / free named). */
  line: string;
  /** Pity points this pull adds on the banner's group (an SR+ ticket adds none). */
  pityGain: number;
}

export interface ScoutOptions {
  bannerId: string; name: string; status: ReturnType<typeof bannerStatus>; paidOnly: boolean; stepUp: boolean;
  wallet: CoinSplit;
  ways: ScoutWay[];
  /** The SR+ ticket, usable on no banner (its own disclosed table, REQ-ITEM-002): shown on the scout screen while held. */
  srPlus: { itemId: string; name: string; owned: number; line: string; oddsPath: string } | null;
  /** One line under the buttons: the spending order (REQ-WAL-002) or the paid-only rule. */
  notice: string;
}

export const SCOUT_NOTICE_ANY = '有償コインから先に使われます。';
export const SCOUT_NOTICE_PAID_ONLY = '有償限定：有償コインだけで引けます（無償コイン・スカウト券は使えません）。';

/** GET /v1/gacha/:bannerId/options — read only. */
export function scoutOptions(m: Master, s: PlayerState, bannerId: string, now: number): ScoutOptions {
  const b = findVisibleBanner(m, bannerId, now);
  const status = bannerStatus(b, now);
  const paidOnly = b.currency === 'paidOnly';
  const wallet = { paid: s.wallet.paid, free: s.wallet.free };
  const debt = s.wallet.debt > 0 || Object.values(s.itemDebt ?? {}).some((n) => n > 0);
  const timeBlock: ScoutBlock = status === 'upcoming' ? 'upcoming' : status === 'ended' ? 'closed' : null;
  const ways: ScoutWay[] = [];
  const counts: (1 | 10)[] = b.stepUp ? [10] : [1, 10];
  for (const count of counts) {
    const price = gachaPrice(b, s, count);
    const pays = spendSplit(wallet, price, paidOnly);
    const block: ScoutBlock = timeBlock ?? (debt ? 'debt' : pays ? null : 'short');
    const have = paidOnly ? wallet.paid : wallet.paid + wallet.free;
    const step = b.stepUp ? `（ステップ${stepIndex(b, s.stepUp?.[b.id] ?? 0) + 1}）` : '';
    ways.push({
      id: `coins_${count}`, via: 'coins', count, itemId: null,
      label: count === 10 ? `10回引く${step}` : '1回引く',
      price, pays, after: pays ? { paid: wallet.paid - pays.paid, free: wallet.free - pays.free } : null,
      owned: null, available: block === null, block, shortfall: pays ? null : price - have,
      line: pays ? spendLine(pays) : paidOnly ? `有償コインが${fmt(price - have)}枚足りません` : `コインが${fmt(price - have)}枚足りません`,
      pityGain: count,
    });
  }
  // REQ-ITEM-001 / REQ-UXS-015: tickets for this banner (never paid-only, never step-up) — only the ones held
  if (!paidOnly && !b.stepUp) {
    for (const [itemId, t] of Object.entries(m.items?.tickets ?? {})) {
      if ((t.kind !== 'single' && t.kind !== 'ten') || !t.banners.includes(b.id)) continue;
      const owned = s.items[itemId] ?? 0;
      if (owned <= 0) continue;
      const count = t.kind === 'ten' ? 10 : 1;
      const block: ScoutBlock = timeBlock ?? (debt ? 'debt' : null);
      ways.push({
        id: `ticket:${itemId}`, via: 'ticket', count, itemId, label: `${t.name}で${count}回引く`,
        price: null, pays: null, after: null, owned, available: block === null, block, shortfall: null,
        line: `${t.name}を1枚使います（コインは使いません）`, pityGain: count,
      });
    }
  }
  const sr = Object.entries(m.items?.tickets ?? {}).find(([, t]) => t.kind === 'srPlus');
  const srOwned = sr ? s.items[sr[0]] ?? 0 : 0;
  return {
    bannerId: b.id, name: b.name, status, paidOnly, stepUp: !!b.stepUp, wallet, ways,
    srPlus: sr && srOwned > 0 ? { itemId: sr[0], name: sr[1].name, owned: srOwned, line: `${sr[1].name}を1枚使います（SR以上が1頭確定・天井ポイントは加算されません）`, oddsPath: `/v1/items/tickets/${sr[0]}/odds` } : null,
    notice: paidOnly ? SCOUT_NOTICE_PAID_ONLY : SCOUT_NOTICE_ANY,
  };
}
