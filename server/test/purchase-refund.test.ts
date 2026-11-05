import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);

function setup(master: Master = m) {
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => NOW, verifiers: { fake: store } });
  let n = 0;
  const buy = (pid: string, productId: string, priceYen: number) =>
    svc.purchase(pid, 'fake', productId, store.issue({ transactionId: `T${++n}`, productId, purchasedAt: NOW, priceYen }));
  return { svc, repo, store, buy, lastTx: () => `T${n}` };
}
const state = (repo: MemoryPlayerRepo, id: string) => JSON.parse(repo.data.get(id)!) as { wallet: { paid: number; free: number; debt: number }; items: Record<string, number>; itemDebt?: Record<string, number>; supportFlags?: string[] };

describe('refunds take back everything a purchase granted', () => {
  it('first-purchase bonus (free) is clawed back; what was spent becomes debt', async () => {
    const { svc, repo, buy, lastTx } = setup();
    await svc.setAge('p1', 1990, 1, false);
    await buy('p1', 'coin_1500', 1500); // 1020 paid + 1020 free bonus
    await svc.draw('p1', 'standard', 10, 'c:g1'); // 1000 from paid
    await svc.draw('p1', 'standard', 10, 'c:g2'); // 20 paid + 980 free
    const r = await svc.refund('p1', lastTx());
    const s = state(repo, 'p1');
    expect(s.wallet).toMatchObject({ paid: 0, free: 0 });
    // owed: 1020 paid (all spent) + 1020 bonus of which 40 free was left
    expect(s.wallet.debt).toBe(1020 + 980);
    expect(r.debt).toBe(2000);
    await expect(svc.draw('p1', 'standard', 1, 'c:g3')).rejects.toMatchObject({ code: 'UNSETTLED_DEBT' });
  });

  it('a paid first-purchase bonus is refunded from its own lot', async () => {
    const { svc, repo, buy, lastTx } = setup({ ...m, firstPurchaseBonusAsPaid: true });
    await svc.setAge('p1', 1990, 1, false);
    await buy('p1', 'coin_1500', 1500);
    expect(state(repo, 'p1').wallet).toMatchObject({ paid: 2040, free: 0 });
    await svc.refund('p1', lastTx());
    expect(state(repo, 'p1').wallet).toMatchObject({ paid: 0, free: 0, debt: 0 });
  });

  it('starter pack: refund removes its items, and the pack stays used', async () => {
    const { svc, repo, buy, lastTx } = setup();
    await svc.setAge('p1', 1990, 1, false);
    await buy('p1', 'starter_pack', 480);
    expect(state(repo, 'p1').items).toMatchObject({ ticket_sr_plus: 1, costume_starter: 1 });
    await svc.refund('p1', lastTx());
    const s = state(repo, 'p1');
    expect(s.items.ticket_sr_plus ?? 0).toBe(0);
    expect(s.items.costume_starter ?? 0).toBe(0);
    expect(s.wallet.paid).toBe(0);
    await expect(svc.purchaseIntent('p1', 'starter_pack')).rejects.toMatchObject({ code: 'ALREADY_PURCHASED' });
  });

  it('items already used become item debt that blocks spending and is settled by the next grant', async () => {
    const { svc, repo, buy, lastTx } = setup();
    await svc.setAge('p1', 1990, 1, false);
    await buy('p1', 'starter_pack', 480);
    // simulate the ticket having been used
    const raw = JSON.parse(repo.data.get('p1')!);
    raw.items.ticket_sr_plus = 0;
    repo.data.set('p1', JSON.stringify(raw));
    const r = await svc.refund('p1', lastTx());
    expect(r.itemsOwed).toEqual({ ticket_sr_plus: 1 });
    expect(state(repo, 'p1').itemDebt).toEqual({ ticket_sr_plus: 1 });
    await expect(svc.purchaseIntent('p1', 'coin_160')).rejects.toMatchObject({ code: 'UNSETTLED_DEBT' });
  });
});

describe('age registration and monthly limits cannot be bypassed', () => {
  it('age is write-once: cannot become older, may become younger, consent can be added', async () => {
    const { svc } = setup();
    await svc.setAge('p1', 2012, 1, false); // 14
    await expect(svc.setAge('p1', 1990, 1, false)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(svc.setAge('p1', 2013, 6, false)).resolves.toMatchObject({ band: 'under16' });
    const again = await svc.setAge('p1', 2013, 6, true);
    expect(again.band).toBe('under16');
    // consent is not silently dropped by a later call
    await svc.setAge('p1', 2013, 6, false);
    await expect(svc.purchaseIntent('p1', 'coin_160')).resolves.toBeTruthy();
  });

  it('a purchase that skipped the intent check and went over the limit blocks further purchases that month', async () => {
    const { svc, repo, buy } = setup();
    await svc.setAge('p1', 2012, 1, true); // under16: ¥5,000
    await buy('p1', 'coin_10000', 10000); // the app skipped purchase-intent; the store already charged
    expect(state(repo, 'p1').supportFlags).toEqual(['monthly_limit_breach:2026-11']);
    await expect(svc.purchaseIntent('p1', 'coin_160')).rejects.toMatchObject({ code: 'AGE_LIMIT_EXCEEDED' });
  });
});
