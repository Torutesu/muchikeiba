import { AppError, assert } from './errors.js';
import type { Master, Product } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import { ageAt, DAY_MS, jstMonthKey } from './time.js';
import { clawbackFree, grantFree, grantPaid, refundPaid } from './wallet.js';
import { addItems, clawbackItems, hasItemDebt } from './items.js';
import { grantSeasonPass, passPurchaseInfo, passPurchasesFor, refundSeasonPass } from './pass.js';
import { classReached, firstPurchaseBonusOf, grantAllowance, pendingAllowance, refundAllowance } from './shop.js';

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
  storeRef?: { token: string; kind: 'product' | 'subscription'; needsAck: boolean; consume?: boolean };
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
  // REQ-UXS-019: a promotion pack is sold once its class has been reached
  if (p.kind === 'promotion' && p.classId && !classReached(m, s, p.classId)) throw new AppError('NOT_ELIGIBLE', `class ${p.classId} not reached yet`);
  // REQ-UXS-020: one pass (Pass or Pass+) per season
  if (p.kind === 'season_pass' && p.storeType !== 'auto_renewing' && passPurchasesFor(s, jstMonthKey(now)).length > 0) throw new AppError('ALREADY_PURCHASED', `a season pass for ${jstMonthKey(now)} is already active`);
  // REQ-UXS-018: the daily pack cannot be bought while one is running
  if (p.kind === 'allowance' && pendingAllowance(m, s, now)) throw new AppError('ALREADY_PURCHASED', 'a daily pack is still running');
  const month = jstMonthKey(now);
  // A purchase that went over the limit this month (e.g. the app skipped this check) blocks further purchases.
  // the breach belongs to the month of purchase (as monthlySpendYen and the support flag), not of grant
  if (s.purchases.some((x) => x.limitBreach && !x.sandbox && (x.month ?? jstMonthKey(x.at)) === month)) throw new AppError('AGE_LIMIT_EXCEEDED', 'monthly limit already exceeded this month');
  const spent = s.monthlySpendYen[month] ?? 0;
  const limit = ab.band.monthlyLimitYen;
  if (limit !== null && spent + p.priceYen > limit) throw new AppError('AGE_LIMIT_EXCEEDED', `monthly ${spent}+${p.priceYen} > ${limit}`);
  // REQ-UXS-020/022: what the confirmation sheet shows besides the price (server-built, per player)
  const bonus = p.kind === 'coins' && !s.firstPurchased.includes(p.id) ? firstPurchaseBonusOf(m, p) : null;
  return {
    product: p, monthSpentYen: spent, monthlyLimitYen: limit, remainingYen: limit === null ? null : limit - spent,
    firstPurchaseBonus: bonus,
    ...(p.kind === 'season_pass' && p.storeType !== 'auto_renewing' ? { pass: passPurchaseInfo(m, p, now) } : {}),
    ...(p.allowance ? { allowance: { days: p.allowance.days, dailyFreeCoins: p.allowance.dailyFreeCoins, autoRenew: false } } : {}),
  };
}

/**
 * REQ-PUR-003..005: grant a verified store purchase, idempotent by transaction id.
 * A completed store purchase cannot be refused, so limit breaches are recorded, not rejected.
 */
export function applyVerifiedPurchase(m: Master, s: PlayerState, platform: PurchaseRecord['platform'], r: VerifiedReceipt, now: number): { record: PurchaseRecord; duplicate: boolean } {
  const existing = s.purchases.find((x) => x.txId === r.transactionId);
  if (existing) return { record: existing, duplicate: true };
  const p = findProduct(m, r.productId);
  // A completed store payment is always credited, even for a once-only product bought again (the app
  // skipped the intent check, or the store re-offered it); support refunds it.
  if (p.once && s.purchases.some((x) => x.productId === p.id)) (s.supportFlags ??= []).push(`once_duplicate:${p.id}:${r.transactionId}`);
  // REQ-UXS-019: a promotion pack is sold once its class is reached; one credited without that (intent skipped) is flagged too
  if (p.kind === 'promotion' && p.classId && !classReached(m, s, p.classId)) (s.supportFlags ??= []).push(`promotion_not_reached:${p.id}:${r.transactionId}`);
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
  let sandboxFree = 0;
  if (r.sandbox) {
    // Sandbox / TestFlight / license-test purchases cost nothing: credit FREE coins only — never a paid lot
    // (usable on paidOnly banners, counted for 資金決済法) and never debt settlement; no first-purchase
    // bonus either (review r5 #7).
    if (p.paidCoins > 0) {
      sandboxFree = p.paidCoins;
      grantFree(s, sandboxFree, now, `sandbox purchase ${p.id}`, r.transactionId, 'grant');
    }
  } else if (p.paidCoins > 0) {
    lotId = grantPaid(s, p.paidCoins, r.priceYen, now, `purchase ${p.id}`, r.transactionId);
  }
  if (p.kind === 'coins' && !r.sandbox && !s.firstPurchased.includes(p.id)) {
    s.firstPurchased.push(p.id);
    bonus = p.paidCoins;
    if (m.firstPurchaseBonusAsPaid) bonusLotId = grantPaid(s, bonus, 0, now, `first purchase bonus ${p.id}`, r.transactionId);
    else grantFree(s, bonus, now, `first purchase bonus ${p.id}`, r.transactionId, 'bonus');
  }
  if (p.items) addItems(s, p.items);
  let passUntil: number | undefined;
  let passSeasonId: string | undefined;
  if (p.kind === 'allowance' && p.allowance) grantAllowance(m, s, p, r.transactionId, now);
  if (p.kind === 'season_pass' && r.expiresAt === undefined && p.storeType !== 'auto_renewing') {
    // REQ-UXS-020: per-season pass, no auto-renew; ends with the season current at the grant
    ({ passUntil, passSeasonId } = grantSeasonPass(m, s, p, r.transactionId, now));
  } else if (p.kind === 'season_pass') {
    if (r.expiresAt !== undefined) {
      // Store subscription: the store's period end is authoritative (renewals arrive as new transactions).
      passUntil = r.expiresAt;
      s.seasonPass.expiresAt = Math.max(s.seasonPass.expiresAt, r.expiresAt);
    } else {
      const base = Math.max(s.seasonPass.expiresAt, now);
      passUntil = base + (p.durationDays ?? 30) * DAY_MS;
      s.seasonPass.expiresAt = passUntil;
    }
  }
  const record: PurchaseRecord = {
    txId: r.transactionId, platform, productId: p.id, priceYen: r.priceYen, at: now, paidCoinsGranted: r.sandbox ? 0 : p.paidCoins, bonusCoinsGranted: bonus, lotId, refunded: false, limitBreach,
    ...(sandboxFree > 0 ? { sandboxFreeGranted: sandboxFree } : {}), month,
    ...(r.sandbox ? { sandbox: true } : {}), ...(r.originalTransactionId ? { originalTxId: r.originalTransactionId } : {}),
    ...(bonusLotId ? { bonusLotId } : {}), ...(passUntil !== undefined ? { passUntil } : {}), ...(passSeasonId ? { passSeasonId } : {}),
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
  if (rec.refunded) return { removed: 0, debt: s.wallet.debt, alreadyRefunded: true, itemsOwed: {} as Record<string, number>, linkedClawback: { freeCoins: 0, items: {} as Record<string, number> } };
  rec.refunded = true;
  const p = findProduct(m, rec.productId);
  const res = refundPaid(s, rec.lotId, rec.paidCoinsGranted, now, transactionId);
  let removed = res.removed;
  if (rec.sandboxFreeGranted) removed += clawbackFree(s, rec.sandboxFreeGranted, now, transactionId).removed;
  if (rec.bonusCoinsGranted > 0) {
    const b = m.firstPurchaseBonusAsPaid || rec.bonusLotId
      ? refundPaid(s, rec.bonusLotId ?? null, rec.bonusCoinsGranted, now, transactionId)
      : clawbackFree(s, rec.bonusCoinsGranted, now, transactionId);
    removed += b.removed;
  }
  const itemsOwed: Record<string, number> = p.items ? clawbackItems(s, p.items) : {};
  // REQ-UXS-018/019/021: value granted after the purchase because of it (daily coins, pass rewards)
  const linked = { freeCoins: 0, items: {} as Record<string, number> };
  if (p.kind === 'allowance') linked.freeCoins += refundAllowance(s, rec, now).freeCoins;
  if (p.kind === 'season_pass') {
    const c = refundSeasonPass(m, s, rec, now);
    linked.freeCoins += c.freeCoins;
    linked.items = c.items;
    for (const [k, v] of Object.entries(c.owedItems)) itemsOwed[k] = (itemsOwed[k] ?? 0) + v;
    recomputePass(m, s, now);
  }
  return { removed, debt: s.wallet.debt, alreadyRefunded: false, itemsOwed, linkedClawback: linked };
}

/**
 * Season pass entitlement = the latest end over every non-refunded pass purchase, each capped by the state
 * of its own store subscription (review r5 #6). A refund, expiry or revocation of one subscription can no
 * longer cut a period paid through another (e.g. iOS ended, Android still active).
 * States written before `passUntil` existed fall back to the old clamp.
 */
function recomputePass(m: Master, s: PlayerState, now: number, legacyClampTo: number = now) {
  const passes = s.purchases.filter((x) => findProduct(m, x.productId).kind === 'season_pass');
  if (passes.some((x) => x.passUntil === undefined)) {
    s.seasonPass.expiresAt = Math.min(s.seasonPass.expiresAt, legacyClampTo);
    return;
  }
  let end = 0;
  for (const x of passes) {
    if (x.refunded) continue;
    let e = x.passUntil!;
    const sub = x.originalTxId ? s.storeSubscriptions?.[x.originalTxId] : undefined;
    if (sub?.status === 'revoked' || sub?.status === 'paused') e = Math.min(e, sub.updatedAt);
    if (sub?.status === 'expired') e = Math.min(e, sub.expiresAt ?? sub.updatedAt);
    end = Math.max(end, e);
  }
  s.seasonPass.expiresAt = end;
}

export type SubscriptionStatus = 'active' | 'canceled' | 'grace' | 'billing_retry' | 'paused' | 'expired' | 'revoked';

/** Store subscription state change (auto-renewing season pass). Entitlement ends on expired/revoked/paused. */
export function applySubscriptionStatus(m: Master, s: PlayerState, platform: PurchaseRecord['platform'], key: string, status: SubscriptionStatus, expiresAt: number | null, now: number) {
  s.storeSubscriptions ??= {};
  s.storeSubscriptions[key] = { platform, status, expiresAt, updatedAt: now };
  if (status === 'revoked' || status === 'paused') recomputePass(m, s, now, now);
  if (status === 'expired') recomputePass(m, s, now, expiresAt ?? now);
  return { key, status, passExpiresAt: s.seasonPass.expiresAt };
}
