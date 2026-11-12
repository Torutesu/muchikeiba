// Quality pass 2 (docs/quality/shop.md): the scout confirmation (GET /v1/gacha/:id/options), the purchase receipt
// (POST /v1/shop/purchase → receipt) and the pass track's total on the product list. Read-only views on the real rules:
// the split they show is exactly what the pull then takes; the receipt's next step only ever uses what was bought.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { spendLine, spendSplit, type ScoutOptions } from '../src/domain/scoutOptions.js';
import { patternUnlockedBy, purchaseReceipt, rewardTimes, type PurchaseReceipt } from '../src/domain/receipt.js';
import { productContents, shopProducts } from '../src/domain/shop.js';
import { clientEventSchema, clientToKpi } from '../src/domain/kpi.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { endpointGroup } from '../src/domain/maintenance.js';
import { CODE_EN } from '../src/i18n/en.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
const translateCodeText = (t: string, master: typeof m) => translateText(t, catalogFor(master)) ?? t;

const JST = 9 * 3600_000;
const NOW = Date.UTC(2026, 10, 5, 12) - JST; // 2026-11-05 12:00 JST (pickup_ginga open)
const BANNED = /倍|今だけ|残りわずか|お得|通常価格/;

function world() {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(7), clock: () => now, verifiers: { fake: store } });
  let tx = 0, k = 0;
  const buy = async (id: string, productId: string) => {
    const p = m.products.find((x) => x.id === productId)!;
    await svc.purchaseIntent(id, productId);
    return svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen })) as Promise<{ receipt: PurchaseReceipt; wallet: { paid: number; free: number } }>;
  };
  const player = async (id: string) => { await svc.bootstrap(id); await svc.setAge(id, 1990, 1, false); };
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c = { master: m, clock: () => now, player: () => invoker, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; } } as unknown as AppContext;
  const call = async (path: string, user: string) => {
    const res = await handle(new Request(`https://x${path}`, { method: 'GET', headers: { 'x-test-user': user } }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, buy, player, call, key: () => `c:k${k++}`, at: (t: number) => { now = t; } };
}

describe('scout confirmation — GET /v1/gacha/:bannerId/options', () => {
  it('spendSplit follows the wallet: paid first, then free; paid-only takes paid only; short → null', () => {
    expect(spendSplit({ paid: 300, free: 2000 }, 1000, false)).toEqual({ paid: 300, free: 700 });
    expect(spendSplit({ paid: 0, free: 2000 }, 1000, false)).toEqual({ paid: 0, free: 1000 });
    expect(spendSplit({ paid: 300, free: 2000 }, 500, true)).toBeNull();
    expect(spendSplit({ paid: 1200, free: 0 }, 1000, true)).toEqual({ paid: 1000, free: 0 });
    expect(spendLine({ paid: 300, free: 700 })).toBe('有償コイン300枚と無償コイン700枚を使います');
    expect(spendLine({ paid: 0, free: 100 })).toBe('無償コイン100枚を使います');
  });

  it('the split shown is exactly what the pull then takes (and the wallet after)', async () => {
    const w = world();
    await w.player('p');
    await w.buy('p', 'coin_480'); await w.buy('p', 'coin_800'); // 840 paid + 840 free (first purchases): a mixed split
    const s0 = await w.svc.state('p');
    const o = await w.svc.scoutOptions('p', 'pickup_ginga') as ScoutOptions;
    expect(o.wallet).toEqual({ paid: s0.wallet.paid, free: s0.wallet.free });
    const ten = o.ways.find((x) => x.id === 'coins_10')!;
    expect(ten).toMatchObject({ via: 'coins', count: 10, price: 1000, available: true, block: null, pityGain: 10 });
    const r = await w.svc.draw('p', 'pickup_ginga', 10, w.key()) as { spent: { paid: number; free: number }; wallet: { paid: number; free: number } };
    expect(ten.pays).toEqual({ paid: 840, free: 160 });
    expect(ten.pays).toEqual(r.spent);
    expect(ten.after).toEqual({ paid: r.wallet.paid, free: r.wallet.free });
    expect(ten.line).toBe(spendLine(r.spent));
    expect(o.notice).toContain('有償コインから先に');
  });

  it('short of coins: not available, the shortfall counted the way protocol §29 counts it', async () => {
    const w = world();
    await w.player('p');
    const s = await w.svc.state('p');
    const have = s.wallet.paid + s.wallet.free;
    const o = await w.svc.scoutOptions('p', 'standard') as ScoutOptions;
    const ten = o.ways.find((x) => x.id === 'coins_10')!;
    if (have < 1000) {
      expect(ten).toMatchObject({ available: false, block: 'short', pays: null, after: null, shortfall: 1000 - have });
      const sf = await w.svc.coinShortfall('p', { for: 'gacha', bannerId: 'standard', count: 10 }) as { shortfall: number };
      expect(sf.shortfall).toBe(ten.shortfall);
    }
  });

  it('tickets held for this banner are ways to pull (no coins); paid-only and step-up banners never list them', async () => {
    const w = world();
    await w.player('p');
    const s = await w.svc.state('p');
    s.items.gacha_ticket = 2; s.items.gacha_ticket_10 = 1; s.items.ticket_sr_plus = 1;
    await (w.svc as unknown as { repo: MemoryPlayerRepo }).repo.put(s);
    const o = await w.svc.scoutOptions('p', 'standard') as ScoutOptions;
    const single = o.ways.find((x) => x.id === 'ticket:gacha_ticket')!;
    const ten = o.ways.find((x) => x.id === 'ticket:gacha_ticket_10')!;
    expect(single).toMatchObject({ via: 'ticket', count: 1, owned: 2, price: null, pays: null, available: true });
    expect(ten).toMatchObject({ via: 'ticket', count: 10, owned: 1, pityGain: 10 });
    expect(single.line).toContain('コインは使いません');
    expect(o.srPlus).toMatchObject({ itemId: 'ticket_sr_plus', owned: 1, oddsPath: '/v1/items/tickets/ticket_sr_plus/odds' });
    // the ticket way really pulls through useTicket on the same banner
    const r = await w.svc.useTicket('p', 'gacha_ticket', 'standard', w.key()) as { remaining: number };
    expect(r.remaining).toBe(1);
    const paidOnly = await w.svc.scoutOptions('p', 'stepup_paid') as ScoutOptions;
    expect(paidOnly.paidOnly).toBe(true);
    expect(paidOnly.ways.every((x) => x.via === 'coins' && x.count === 10)).toBe(true); // step-up: 10 at a time, no tickets
    expect(paidOnly.ways[0]!.label).toMatch(/ステップ1/);
    expect(paidOnly.notice).toContain('有償限定');
  });

  it('a ticket the player does not hold is not listed; the SR+ ticket is null when not held', async () => {
    const w = world();
    await w.player('p');
    const o = await w.svc.scoutOptions('p', 'standard') as ScoutOptions;
    expect(o.ways.filter((x) => x.via === 'ticket' && (x.owned ?? 0) <= 0)).toHaveLength(0);
    expect(o.srPlus).toBeNull();
  });

  it('over HTTP (player auth), core maintenance group, unknown banner 404, every line in English', async () => {
    const w = world();
    await w.player('p');
    const r = await w.call('/v1/gacha/pickup_ginga/options', 'p');
    expect(r.status).toBe(200);
    expect(r.body.ways.length).toBeGreaterThan(0);
    expect((await w.call('/v1/gacha/nope/options', 'p')).status).toBe(404);
    expect(endpointGroup('/v1/gacha/pickup_ginga/options')).toBe(endpointGroup('/v1/gacha/status'));
    const o = await w.svc.scoutOptions('p', 'pickup_ginga') as ScoutOptions;
    for (const t of [o.notice, ...o.ways.flatMap((x) => [x.label, x.line])]) {
      expect(t).not.toMatch(BANNED);
      expect(translateCodeText(t, m)).not.toMatch(/[぀-ヿ一-鿿]/);
    }
  });
});

describe('purchase receipt — POST /v1/shop/purchase → receipt', () => {
  it('the starter pack: paid coins, the SR+ ticket with what it does, the silks pattern; next = use the SR+ ticket', async () => {
    const w = world();
    await w.player('p');
    const r = await w.buy('p', 'starter_pack');
    const rc = r.receipt;
    expect(rc).toMatchObject({ productId: 'starter_pack', priceYen: 480 });
    expect(rc.lines.map((l) => l.kind)).toEqual(['paid_coins', 'item', 'item']);
    expect(rc.lines.find((l) => l.itemId === 'ticket_sr_plus')!.purpose).toContain('SR以上');
    expect(rc.lines.find((l) => l.itemId === 'costume_starter')!.purpose).toContain('ランク戦の能力は変わりません');
    expect(rc.next).toEqual({ action: 'use_sr_ticket', label: 'SR以上確定スカウト券を使う', itemId: 'ticket_sr_plus', pattern: null });
    expect(rc.wallet).toEqual({ paid: r.wallet.paid, free: r.wallet.free });
    expect(rc.notes.at(-1)).toContain('購入履歴');
  });

  it('a coin pack names the first-purchase coins as free coins (never 「倍」); next = scout', async () => {
    const w = world();
    await w.player('p');
    const rc = (await w.buy('p', 'coin_480')).receipt;
    expect(rc.lines).toEqual([
      { kind: 'paid_coins', label: '有償コイン310枚', purpose: null, qty: 310 },
      { kind: 'bonus_free_coins', label: 'はじめての購入の無償コイン310枚', purpose: null, qty: 310 },
    ]);
    expect(rc.next?.action).toBe('scout');
    const again = (await w.buy('p', 'coin_480')).receipt; // the second time: no bonus line
    expect(again.lines.map((l) => l.kind)).toEqual(['paid_coins']);
  });

  it('the pass: the track until the real season end, no auto-renewal; next = the pass screen; a promotion pack → wear the silks', async () => {
    const w = world();
    await w.player('p');
    const rc = (await w.buy('p', 'season_pass')).receipt;
    expect(rc.lines[0]).toMatchObject({ kind: 'pass', label: 'シーズンパス有料ライン 全30段', endsAt: Date.UTC(2026, 11, 1) - JST });
    expect(rc.notes.some((n) => n.includes('暦月'))).toBe(true);
    expect(rc.next?.action).toBe('open_pass');
    expect(rc.notes.some((n) => n.includes('自動更新はありません'))).toBe(true);
    const al = (await w.buy('p', 'stable_allowance_30d')).receipt;
    expect(al.next?.action).toBe('claim_allowance');
    // a pack whose only item is a silks pattern: wear it (the pattern visuals.json unlocks with that item)
    expect(patternUnlockedBy('costume_promo_b')).toBe('promo_b');
    const s = await w.svc.state('p');
    const rec = { ...s.purchases[0]!, productId: 'promo_pack_B', paidCoinsGranted: 1020, bonusCoinsGranted: 0 };
    expect(purchaseReceipt(m, s, rec).next).toEqual({ action: 'wear_silks', label: '勝負服に着せてみる', itemId: 'costume_promo_b', pattern: 'promo_b' });
  });

  it('the receipt never points at another product, and every line has English with no banned word', async () => {
    const w = world();
    await w.player('p');
    for (const id of ['starter_pack', 'coin_160', 'season_pass_plus']) {
      const rc = (await w.buy('p', id)).receipt;
      expect(['use_sr_ticket', 'wear_silks', 'open_pass', 'claim_allowance', 'scout']).toContain(rc.next!.action);
      for (const t of [rc.next!.label, ...rc.notes, ...rc.lines.flatMap((l) => [l.label, l.purpose ?? ''])].filter(Boolean)) {
        expect(t).not.toMatch(BANNED);
        expect(translateCodeText(t, m)).not.toMatch(/[぀-ヿ一-鿿]/);
      }
    }
  });
});

describe('shop products — the pass track total and what items do', () => {
  it('pass_premium carries every tier added up (stated as a sum, never a ratio); items carry their purpose', () => {
    const pass = m.products.find((p) => p.id === 'season_pass')!;
    const c = productContents(m, pass);
    const pp = c.find((x) => x.type === 'pass_premium') as Extract<ReturnType<typeof productContents>[number], { type: 'pass_premium' }>;
    const pr = m.progression.passRewards.premium;
    expect(pp.total).toEqual(rewardTimes(pr.reward, pp.levels));
    expect(pp.total.freeCoins).toBe((pr.reward.freeCoins ?? 0) * pp.levels);
    expect(pp.totalLabel).toBe(`${pp.levels}段の合計：無償コイン${(pp.total.freeCoins!).toLocaleString('en-US')}枚＋配合素材×${pp.levels}`);
    expect(pp.totalLabel).not.toMatch(BANNED);
    expect(translateCodeText(pp.totalLabel, m)).toBe(`All ${pp.levels} tiers together: ${(pp.total.freeCoins!).toLocaleString('en-US')} free coins + Breeding Material ×${pp.levels}`);
    const starter = shopProducts(m).products.find((p) => p.id === 'starter_pack')!;
    const item = starter.contents.find((x) => x.type === 'item' && x.itemId === 'ticket_sr_plus') as { purpose: string | null };
    expect(item.purpose).toContain('SR以上');
    // the legacy label is unchanged (clients that read only `label` see the same text)
    expect(pp.label).toBe(`シーズンパス有料ライン 全${pp.levels}段（各段：無償コイン50枚＋配合素材×1）`);
  });

  it('every product item has a purpose that says looks-only items do not change ranked ability', () => {
    for (const p of m.products) for (const it of p.items ?? []) {
      const purpose = m.shopDisplay!.itemPurposes![it.itemId];
      expect(purpose, `${p.id} ${it.itemId}`).toBeTruthy();
      if (it.itemId.startsWith('costume_') || it.itemId.startsWith('tack_')) expect(purpose).toContain('ランク戦の能力は変わりません');
    }
  });
});

describe('KPI (§58): scout_confirm / purchase_receipt are optional client rows with counts only', () => {
  it('schema, mapping and class', () => {
    const a = clientEventSchema.parse({ name: 'scout_confirm', at: 1, props: { stage: 'pull', via: 'ticket', count: 10 } });
    expect(clientToKpi(a)).toEqual({ name: 'scout_confirm', s1: 'pull', s2: 'ticket', count: 10 });
    const b = clientEventSchema.parse({ name: 'purchase_receipt', at: 1, props: { stage: 'next', productId: 'starter_pack', action: 'use_sr_ticket' } });
    expect(clientToKpi(b)).toEqual({ name: 'purchase_receipt', s1: 'next', s2: 'starter_pack', s3: 'use_sr_ticket' });
    expect(() => clientEventSchema.parse({ name: 'scout_confirm', at: 1, props: { stage: 'pull', via: 'coins', count: 10, bannerId: 'x' } })).toThrow();
    expect(kpiClassOf('scout_confirm')).toBe('optional');
    expect(kpiClassOf('purchase_receipt')).toBe('optional');
    expect(CODE_EN['{levels}段の合計：{reward}']).toBeTruthy();
  });
});
