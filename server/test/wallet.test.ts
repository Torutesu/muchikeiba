import { describe, expect, it } from 'vitest';
import { grantFree, grantPaid, invariantsHold, paidBalanceYen, refundPaid, spend } from '../src/domain/wallet.js';
import { applyRefund, applyVerifiedPurchase, checkPurchaseIntent, FakeStoreVerifier, registerAge } from '../src/domain/purchase.js';
import { aggregatePaidBalances, isBaseDate } from '../src/domain/accounting.js';
import { freshPlayer, m } from './helpers.js';
import { AppError } from '../src/domain/errors.js';

const NOW = Date.UTC(2026, 10, 5, 3); // 2026-11-05 12:00 JST
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

describe('wallet (REQ-WAL-001..003)', () => {
  it('spends paid first and records ledger rows', () => {
    const s = freshPlayer();
    grantFree(s, 500, NOW, 'gift', 'g1');
    grantPaid(s, 300, 480, NOW, 'buy', 'tx1');
    const r = spend(s, 400, { paidOnly: false }, NOW, 'gacha', 'b');
    expect(r).toEqual({ paid: 300, free: 100 });
    expect(s.wallet).toMatchObject({ paid: 0, free: 400 });
    expect(s.ledger.map((l) => [l.kind, l.currency, l.delta])).toEqual([
      ['grant', 'free', 500], ['purchase', 'paid', 300], ['spend', 'paid', -300], ['spend', 'free', -100],
    ]);
    expect(invariantsHold(s)).toBe(true);
  });
  it('paid-only spending ignores free coins; never goes negative', () => {
    const s = freshPlayer();
    grantFree(s, 5000, NOW, 'gift', 'g');
    grantPaid(s, 50, 80, NOW, 'buy', 'tx');
    expect(code(() => spend(s, 100, { paidOnly: true }, NOW, 'x', 'y'))).toBe('INSUFFICIENT_COINS');
    expect(code(() => spend(s, 6000, { paidOnly: false }, NOW, 'x', 'y'))).toBe('INSUFFICIENT_COINS');
    expect(s.wallet).toMatchObject({ paid: 50, free: 5000 });
    expect(code(() => spend(s, -1, { paidOnly: false }, NOW, 'x', 'y'))).toBe('BAD_REQUEST');
  });
  it('consumes paid lots FIFO and values the balance at purchase price (REQ-WAL-005)', () => {
    const s = freshPlayer();
    grantPaid(s, 100, 160, NOW, 'a', 't1'); // 1.6 yen/coin
    grantPaid(s, 7400, 10000, NOW, 'b', 't2'); // ~1.351 yen/coin
    spend(s, 150, { paidOnly: true }, NOW, 'x', 'y');
    expect(s.wallet.lots.map((l) => l.remaining)).toEqual([7350]);
    expect(paidBalanceYen(s)).toBe(Math.floor((7350 * 10000) / 7400));
  });
  it('refund beyond balance becomes debt that blocks spending and is settled by the next purchase', () => {
    const s = freshPlayer();
    const lot = grantPaid(s, 1020, 1500, NOW, 'buy', 'tx1');
    spend(s, 1000, { paidOnly: false }, NOW, 'gacha', 'b');
    const r = refundPaid(s, lot, 1020, NOW, 'tx1');
    expect(r).toEqual({ removed: 20, debt: 1000 });
    expect(s.wallet).toMatchObject({ paid: 0, debt: 1000 });
    expect(code(() => spend(s, 0, { paidOnly: false }, NOW, 'x', 'y'))).toBe('UNSETTLED_DEBT');
    grantPaid(s, 1660, 2400, NOW, 'buy', 'tx2');
    expect(s.wallet).toMatchObject({ paid: 660, debt: 0 });
    expect(invariantsHold(s)).toBe(true);
  });
});

describe('purchase flow (REQ-PUR-*)', () => {
  const adult = () => { const s = freshPlayer(); registerAge(m, s, 1990, 1, false, NOW); return s; };
  const receipt = (productId: string, priceYen: number, tx = `tx_${productId}`) => ({ transactionId: tx, productId, purchasedAt: NOW, priceYen });

  it('requires age registration and guardian consent for minors', () => {
    const s = freshPlayer();
    expect(code(() => checkPurchaseIntent(m, s, 'coin_160', NOW))).toBe('AGE_REQUIRED');
    registerAge(m, s, 2012, 4, false, NOW); // 14
    expect(code(() => checkPurchaseIntent(m, s, 'coin_160', NOW))).toBe('GUARDIAN_CONSENT_REQUIRED');
    registerAge(m, s, 2012, 4, true, NOW);
    expect(checkPurchaseIntent(m, s, 'coin_160', NOW).monthlyLimitYen).toBe(5000);
  });
  it('enforces the monthly limit per age band (JST month)', () => {
    const s = freshPlayer();
    registerAge(m, s, 2012, 4, true, NOW); // under16: 5000 (未確定)
    applyVerifiedPurchase(m, s, 'fake', receipt('coin_3800', 3800), NOW);
    expect(code(() => checkPurchaseIntent(m, s, 'coin_1500', NOW))).toBe('AGE_LIMIT_EXCEEDED');
    expect(checkPurchaseIntent(m, s, 'coin_800', NOW).remainingYen).toBe(1200);
    const nextMonth = Date.UTC(2026, 10, 30, 15, 0); // 2026-12-01 00:00 JST
    expect(checkPurchaseIntent(m, s, 'coin_1500', nextMonth).monthSpentYen).toBe(0);
  });
  it('adults have no limit; unknown products rejected', () => {
    const s = adult();
    expect(checkPurchaseIntent(m, s, 'coin_10000', NOW).monthlyLimitYen).toBeNull();
    expect(code(() => checkPurchaseIntent(m, s, 'nope', NOW))).toBe('UNKNOWN_PRODUCT');
  });
  it('grants paid coins + first-purchase free bonus once per product, idempotent by transaction', () => {
    const s = adult();
    const a = applyVerifiedPurchase(m, s, 'fake', receipt('coin_480', 480, 't1'), NOW);
    expect(a.duplicate).toBe(false);
    expect(s.wallet).toMatchObject({ paid: 310, free: 310 });
    expect(applyVerifiedPurchase(m, s, 'fake', receipt('coin_480', 480, 't1'), NOW).duplicate).toBe(true);
    applyVerifiedPurchase(m, s, 'fake', receipt('coin_480', 480, 't2'), NOW);
    expect(s.wallet).toMatchObject({ paid: 620, free: 310 });
  });
  it('starter pack is once only; season pass extends expiry; refund revokes', () => {
    const s = adult();
    applyVerifiedPurchase(m, s, 'fake', receipt('starter_pack', 480), NOW);
    expect(s.items).toMatchObject({ ticket_sr_plus: 1, costume_starter: 1 });
    expect(code(() => checkPurchaseIntent(m, s, 'starter_pack', NOW))).toBe('ALREADY_PURCHASED');
    applyVerifiedPurchase(m, s, 'fake', receipt('season_pass', 1000, 'sp1'), NOW);
    expect(s.seasonPass.expiresAt).toBe(NOW + 30 * 86400000);
    applyVerifiedPurchase(m, s, 'fake', receipt('season_pass', 1000, 'sp2'), NOW);
    expect(s.seasonPass.expiresAt).toBe(NOW + 60 * 86400000);
    applyRefund(m, s, 'sp2', NOW + 1);
    expect(s.seasonPass.expiresAt).toBe(NOW + 1);
    expect(applyRefund(m, s, 'sp2', NOW + 2).alreadyRefunded).toBe(true);
  });
  it('blocks new purchases while refund debt is unsettled', () => {
    const s = adult();
    applyVerifiedPurchase(m, s, 'fake', receipt('coin_1500', 1500, 'r1'), NOW);
    spend(s, 1020, { paidOnly: true }, NOW, 'g', 'b');
    applyRefund(m, s, 'r1', NOW);
    expect(s.wallet.debt).toBe(1020);
    expect(code(() => checkPurchaseIntent(m, s, 'coin_160', NOW))).toBe('UNSETTLED_DEBT');
  });
  it('fake store verifier checks product and token', async () => {
    const v = new FakeStoreVerifier();
    const tok = v.issue(receipt('coin_160', 160));
    await expect(v.verify(tok, 'coin_160')).resolves.toMatchObject({ productId: 'coin_160' });
    await expect(v.verify(tok, 'coin_480')).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
    await expect(v.verify('bogus', 'coin_160')).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
  });
});

describe('payment services act aggregation (REQ-WAL-005)', () => {
  it('sums the latest snapshot per player and flags the 10M yen threshold', () => {
    const r = aggregatePaidBalances([
      { playerId: 'a', date: '2027-03-30', paidCoins: 10, paidYen: 999 },
      { playerId: 'a', date: '2027-03-31', paidCoins: 5, paidYen: 6_000_000 },
      { playerId: 'b', date: '2027-03-31', paidCoins: 5, paidYen: 4_000_001 },
    ]);
    expect(r).toMatchObject({ players: 2, totalPaidYen: 10_000_001, exceedsThreshold: true, requiredDepositYen: 5_000_001 });
    expect(isBaseDate(Date.UTC(2027, 2, 31, 3))).toBe(true);
    expect(isBaseDate(Date.UTC(2027, 8, 30, 3))).toBe(true);
    expect(isBaseDate(Date.UTC(2027, 2, 30, 3))).toBe(false);
  });
});
