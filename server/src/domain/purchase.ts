import { AppError, assert } from './errors.js';
import type { Master, Product } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import { ageAt, DAY_MS, jstMonthKey } from './time.js';
import { clawbackFree, grantFree, grantPaid, refundPaid } from './wallet.js';
import { addItems, clawbackItems, hasItemDebt } from './items.js';

/** Store receipt verification result (Apple App Store Server API / Google Play Developer API behind an adapter). */
export interface VerifiedReceipt {
  /** Unique per paid period. Real stores are prefixed (`apple:…`, `google:…`) so platforms never collide. */
  transactionId: string;
  productId: string;
  purchasedAt: number;
  /** 0 for sandbox/test purchases (no real money). */
  priceYen: number;
  sandbox?: boolean;
  /** Subscriptions: stable id across renewals (`apple:<originalTransactionId>` / `google:sub:<purchaseToken>`). */
  originalTransactionId?: string;
  /** Subscriptions: end of the paid period, from the store. */
  expiresAt?: number;
  /** Store follow-up needed after the grant is saved (Google consume/acknowledge). */
  storeRef?: { token: string; kind: 'product' | 'subscription'; needsAck: boolean };
}
export interface StoreVerifier {
  readonly platform: 'apple' | 'google' | 'fake';
  /** `ctx.playerId` lets the store adapter check the purchase's account binding (appAccountToken / obfuscatedAccountId). */
  verify(receipt: string, expectedProductId: string, ctx?: { playerId: string }): Promise<VerifiedReceipt>;
  /** Called after the grant is saved (also on idempotent replays). Failures are retried by the next replay. */
  finalize?(r: VerifiedReceipt): Promise<void>;
}

/** In-memory fake store: receipts are JSON strings issued by `issue`. For tests and local dev only. */
export class FakeStoreVerifier implements StoreVerifier {
  readonly platform = 'fake' as const;
  private readonly issued = new Map<string, VerifiedReceipt>();
  issue(r: VerifiedReceipt): string {
    const token = `fake:${r.transactionId}`;
    this.issued.set(token, r);
    return token;
  }
  async verify(receipt: string, expectedProductId: string): Promise<VerifiedReceipt> {
    const r = this.issued.get(receipt);
    if (!r || r.productId !== expectedProductId) throw new AppError('RECEIPT_INVALID');
    return r;
  }
}

export function findProduct(m: Master, productId: string): Product {
  const p = m.products.find((x) => x.id === productId);
  if (!p) throw new AppError('UNKNOWN_PRODUCT', productId);
  return p;
}

export function ageBand(m: Master, s: PlayerState, now: number) {
  if (!s.age) return null;
  const age = ageAt(s.age.birthYear, s.age.birthMonth, now);
  const band = m.ageLimits.bands.find((b) => age >= b.minAge && age <= b.maxAge);
  if (!band) throw new AppError('CONFIG_INVALID', `no age band for ${age}`);
  return { age, band };
}

/**
 * REQ-PUR-002 age registration. Write-once from the app: a registered birth date may only move later
 * (younger ⇒ stricter limits), so a minor cannot re-register as an adult to lift the monthly cap.
 * Guardian consent can be added. Other corrections go through support (`force`).
 */
export function registerAge(m: Master, s: PlayerState, birthYear: number, birthMonth: number, guardianConsent: boolean, now: number, force = false) {
  assert(Number.isInteger(birthYear) && Number.isInteger(birthMonth) && birthMonth >= 1 && birthMonth <= 12, 'BAD_REQUEST', 'invalid birth year/month');
  const age = ageAt(birthYear, birthMonth, now);
  assert(age >= 0 && age <= 120, 'BAD_REQUEST', 'implausible age');
  if (s.age && !force) {
    const prev = s.age.birthYear * 12 + s.age.birthMonth;
    const next = birthYear * 12 + birthMonth;
    if (next < prev) throw new AppError('CONFLICT', 'age is already registered; contact support to correct it');
    guardianConsent = guardianConsent || (next === prev && s.age.guardianConsent);
  }
  s.age = { birthYear, birthMonth, guardianConsent, setAt: now };
  return ageBand(m, s, now)!;
}

/** REQ-PUR-001: may the player start this store purchase? Throws with a specific code if not. */
export function checkPurchaseIntent(m: Master, s: PlayerState, productId: string, now: number) {
  const p = findProduct(m, productId);
  if (!s.age) throw new AppError('AGE_REQUIRED');
  if (s.wallet.debt > 0 || hasItemDebt(s)) throw new AppError('UNSETTLED_DEBT');
  const ab = ageBand(m, s, now)!;
  if (ab.age < m.ageLimits.guardianConsentUnderAge && !s.age.guardianConsent) throw new AppError('GUARDIAN_CONSENT_REQUIRED');
  // once-only products stay used even if refunded (otherwise buy → refund → buy farms the bundle).
  if (p.once && s.purchases.some((x) => x.productId === p.id)) throw new AppError('ALREADY_PURCHASED');
  const month = jstMonthKey(now);
  // A purchase that went over the limit this month (e.g. the app skipped this check) blocks further purchases.
  if (s.purchases.some((x) => x.limitBreach && !x.sandbox && jstMonthKey(x.at) === month)) throw new AppError('AGE_LIMIT_EXCEEDED', 'monthly limit already exceeded this month');
  const spent = s.monthlySpendYen[month] ?? 0;
  const limit = ab.band.monthlyLimitYen;
  if (limit !== null && spent + p.priceYen > limit) throw new AppError('AGE_LIMIT_EXCEEDED', `monthly ${spent}+${p.priceYen} > ${limit}`);
  return { product: p, monthSpentYen: spent, monthlyLimitYen: limit, remainingYen: limit === null ? null : limit - spent };
}

/**
 * REQ-PUR-003..005: grant a verified store purchase, idempotent by transaction id.
 * A completed store purchase cannot be refused, so limit breaches are recorded, not rejected.
 */
export function applyVerifiedPurchase(m: Master, s: PlayerState, platform: PurchaseRecord['platform'], r: VerifiedReceipt, now: number): { record: PurchaseRecord; duplicate: boolean } {
  const existing = s.purchases.find((x) => x.txId === r.transactionId);
  if (existing) return { record: existing, duplicate: true };
  const p = findProduct(m, r.productId);
  const month = jstMonthKey(r.purchasedAt);
  const ab = ageBand(m, s, now);
  const limit = ab?.band.monthlyLimitYen ?? null;
  const spentBefore = s.monthlySpendYen[month] ?? 0;
  const limitBreach = s.age === null || (limit !== null && spentBefore + r.priceYen > limit);
  s.monthlySpendYen[month] = spentBefore + r.priceYen;

  if (limitBreach && !r.sandbox) {
    s.supportFlags ??= [];
    const flag = `monthly_limit_breach:${month}`;
    if (!s.supportFlags.includes(flag)) s.supportFlags.push(flag);
  }

  let lotId: string | null = null;
  let bonusLotId: string | null = null;
  let bonus = 0;
  if (p.paidCoins > 0) {
    lotId = grantPaid(s, p.paidCoins, r.priceYen, now, `purchase ${p.id}`, r.transactionId);
  }
  if (p.kind === 'coins' && !s.firstPurchased.includes(p.id)) {
    s.firstPurchased.push(p.id);
    bonus = p.paidCoins;
    if (m.firstPurchaseBonusAsPaid) bonusLotId = grantPaid(s, bonus, 0, now, `first purchase bonus ${p.id}`, r.transactionId);
    else grantFree(s, bonus, now, `first purchase bonus ${p.id}`, r.transactionId, 'bonus');
  }
  if (p.items) addItems(s, p.items);
  if (p.kind === 'season_pass') {
    if (r.expiresAt !== undefined) {
      // Store subscription: the store's period end is authoritative (renewals arrive as new transactions).
      s.seasonPass.expiresAt = Math.max(s.seasonPass.expiresAt, r.expiresAt);
    } else {
      const base = Math.max(s.seasonPass.expiresAt, now);
      s.seasonPass.expiresAt = base + (p.durationDays ?? 30) * DAY_MS;
    }
  }
  const record: PurchaseRecord = {
    txId: r.transactionId, platform, productId: p.id, priceYen: r.priceYen, at: now, paidCoinsGranted: p.paidCoins, bonusCoinsGranted: bonus, lotId, refunded: false, limitBreach,
    ...(r.sandbox ? { sandbox: true } : {}), ...(r.originalTransactionId ? { originalTxId: r.originalTransactionId } : {}),
    ...(bonusLotId ? { bonusLotId } : {}),
  };
  s.purchases.push(record);
  return { record, duplicate: false };
}

/**
 * REQ-PUR-006: store refund/revocation notification. Idempotent.
 * Takes back everything the purchase granted: paid coins, the first-purchase bonus (paid or free) and
 * items. What was already spent or used becomes debt (coins) / itemDebt (items), which blocks gacha and
 * purchases until settled. The first-purchase bonus stays used (no bonus farming via refunds).
 */
export function applyRefund(m: Master, s: PlayerState, transactionId: string, now: number) {
  const rec = s.purchases.find((x) => x.txId === transactionId);
  if (!rec) throw new AppError('NOT_FOUND', `purchase ${transactionId}`);
  if (rec.refunded) return { removed: 0, debt: s.wallet.debt, alreadyRefunded: true, itemsOwed: {} };
  rec.refunded = true;
  const p = findProduct(m, rec.productId);
  const res = refundPaid(s, rec.lotId, rec.paidCoinsGranted, now, transactionId);
  let removed = res.removed;
  if (rec.bonusCoinsGranted > 0) {
    const b = m.firstPurchaseBonusAsPaid || rec.bonusLotId
      ? refundPaid(s, rec.bonusLotId ?? null, rec.bonusCoinsGranted, now, transactionId)
      : clawbackFree(s, rec.bonusCoinsGranted, now, transactionId);
    removed += b.removed;
  }
  const itemsOwed = p.items ? clawbackItems(s, p.items) : {};
  if (p.kind === 'season_pass') s.seasonPass.expiresAt = Math.min(s.seasonPass.expiresAt, now);
  return { removed, debt: s.wallet.debt, alreadyRefunded: false, itemsOwed };
}

export type SubscriptionStatus = 'active' | 'canceled' | 'grace' | 'billing_retry' | 'paused' | 'expired' | 'revoked';

/** Store subscription state change (auto-renewing season pass). Entitlement ends on expired/revoked/paused. */
export function applySubscriptionStatus(s: PlayerState, platform: PurchaseRecord['platform'], key: string, status: SubscriptionStatus, expiresAt: number | null, now: number) {
  s.storeSubscriptions ??= {};
  s.storeSubscriptions[key] = { platform, status, expiresAt, updatedAt: now };
  if (status === 'revoked' || status === 'paused') s.seasonPass.expiresAt = Math.min(s.seasonPass.expiresAt, now);
  if (status === 'expired') s.seasonPass.expiresAt = Math.min(s.seasonPass.expiresAt, expiresAt ?? now);
  return { key, status, passExpiresAt: s.seasonPass.expiresAt };
}
