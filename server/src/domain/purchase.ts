import { AppError, assert } from './errors.js';
import type { Master, Product } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import { ageAt, DAY_MS, jstMonthKey } from './time.js';
import { grantFree, grantPaid, refundPaid } from './wallet.js';
import { addItems } from './items.js';

/** Store receipt verification result (Apple App Store Server API / Google Play Developer API behind an adapter). */
export interface VerifiedReceipt { transactionId: string; productId: string; purchasedAt: number; priceYen: number }
export interface StoreVerifier {
  readonly platform: 'apple' | 'google' | 'fake';
  verify(receipt: string, expectedProductId: string): Promise<VerifiedReceipt>;
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

/** REQ-PUR-002 age registration. */
export function registerAge(m: Master, s: PlayerState, birthYear: number, birthMonth: number, guardianConsent: boolean, now: number) {
  assert(Number.isInteger(birthYear) && Number.isInteger(birthMonth) && birthMonth >= 1 && birthMonth <= 12, 'BAD_REQUEST', 'invalid birth year/month');
  const age = ageAt(birthYear, birthMonth, now);
  assert(age >= 0 && age <= 120, 'BAD_REQUEST', 'implausible age');
  s.age = { birthYear, birthMonth, guardianConsent, setAt: now };
  return ageBand(m, s, now)!;
}

/** REQ-PUR-001: may the player start this store purchase? Throws with a specific code if not. */
export function checkPurchaseIntent(m: Master, s: PlayerState, productId: string, now: number) {
  const p = findProduct(m, productId);
  if (!s.age) throw new AppError('AGE_REQUIRED');
  if (s.wallet.debt > 0) throw new AppError('UNSETTLED_DEBT');
  const ab = ageBand(m, s, now)!;
  if (ab.age < m.ageLimits.guardianConsentUnderAge && !s.age.guardianConsent) throw new AppError('GUARDIAN_CONSENT_REQUIRED');
  if (p.once && s.purchases.some((x) => x.productId === p.id && !x.refunded)) throw new AppError('ALREADY_PURCHASED');
  const month = jstMonthKey(now);
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

  let lotId: string | null = null;
  let bonus = 0;
  if (p.paidCoins > 0) {
    lotId = grantPaid(s, p.paidCoins, r.priceYen, now, `purchase ${p.id}`, r.transactionId);
  }
  if (p.kind === 'coins' && !s.firstPurchased.includes(p.id)) {
    s.firstPurchased.push(p.id);
    bonus = p.paidCoins;
    if (m.firstPurchaseBonusAsPaid) grantPaid(s, bonus, 0, now, `first purchase bonus ${p.id}`, r.transactionId);
    else grantFree(s, bonus, now, `first purchase bonus ${p.id}`, r.transactionId, 'bonus');
  }
  if (p.items) addItems(s, p.items);
  if (p.kind === 'season_pass') {
    const base = Math.max(s.seasonPass.expiresAt, now);
    s.seasonPass.expiresAt = base + (p.durationDays ?? 30) * DAY_MS;
  }
  const record: PurchaseRecord = { txId: r.transactionId, platform, productId: p.id, priceYen: r.priceYen, at: now, paidCoinsGranted: p.paidCoins, bonusCoinsGranted: bonus, lotId, refunded: false, limitBreach };
  s.purchases.push(record);
  return { record, duplicate: false };
}

/** REQ-PUR-006: store refund/revocation notification. Idempotent. */
export function applyRefund(m: Master, s: PlayerState, transactionId: string, now: number) {
  const rec = s.purchases.find((x) => x.txId === transactionId);
  if (!rec) throw new AppError('NOT_FOUND', `purchase ${transactionId}`);
  if (rec.refunded) return { removed: 0, debt: s.wallet.debt, alreadyRefunded: true };
  rec.refunded = true;
  const p = findProduct(m, rec.productId);
  const res = refundPaid(s, rec.lotId, rec.paidCoinsGranted, now, transactionId);
  if (p.kind === 'season_pass') s.seasonPass.expiresAt = Math.min(s.seasonPass.expiresAt, now);
  return { ...res, alreadyRefunded: false };
}
