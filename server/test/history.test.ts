// REQ-HIST-001..014: 購入履歴・コイン履歴・ガチャ履歴 (contracts/protocol.md §33).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { catalogFor, enWordingProblems, localize, untranslated } from '../src/i18n/catalog.js';
import {
  classifyLedger, COIN_TITLES, decodeCursor, encodeCursor, HISTORY_LIMITS, PURCHASE_STATUS_TEXT, purchaseRef, recordGachaLog, SUPPORT_TOPIC_TEXT,
  type CoinRow, type GachaRow, type PurchaseRow,
} from '../src/domain/history.js';
import { clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { DAY_MS } from '../src/domain/time.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 9, 3);
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789' };

async function setup() {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(11), clock: () => now, verifiers: { fake: store } });
  let n = 0;
  const buy = (pid: string, productId: string, priceYen: number, extra: { sandbox?: boolean } = {}) =>
    svc.purchase(pid, 'fake', productId, store.issue({ transactionId: `fake:ORDER-${++n}`, productId, purchasedAt: now, priceYen, ...extra }));
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await sha256Hex(TOKENS[name]) }))) };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
  };
  const get = async (user: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json', ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const admin = async (path: string, who: keyof typeof TOKENS = 'viewer') => {
    const res = await handle(new Request(`https://x${path}`, { headers: { authorization: `Bearer ${TOKENS[who]}` } }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, repo, store, buy, get, admin, ops, setNow: (t: number) => { now = t; }, now: () => now };
}

/** A player with purchases, a refund, a sandbox purchase, gacha draws on coins / ticket / tutorial and a support grant. */
async function seeded() {
  const x = await setup();
  await x.svc.setAge('u1', 2012, 1, true); // 14: under16 band (¥5,000 a month)
  await x.svc.tutorialDraw('u1', 'c:tut');
  await x.buy('u1', 'coin_480', 480); // 310 paid + first-purchase extra (free)
  await x.buy('u1', 'coin_1500', 1500);
  await x.buy('u1', 'coin_160', 0, { sandbox: true });
  await x.svc.draw('u1', 'standard', 10, 'c:d1');
  await x.svc.draw('u1', 'standard', 1, 'c:d2');
  await x.svc.adminGrant('u1', { freeCoins: 50, items: [{ itemId: 'gacha_ticket', qty: 1 }] }, 'server outage 11/08', 'ops-alice', 'comp-1');
  await x.svc.giftClaimAll('u1', 'c:gifts'); // Round 12: the grant waits in the gift box (§26.1) until claimed
  await x.svc.useTicket('u1', 'gacha_ticket', 'standard', 'c:t1');
  await x.svc.refund('u1', 'fake:ORDER-2');
  return x;
}

describe('purchase history (REQ-HIST-002/005/007)', () => {
  it('lists purchases newest first with store, price and status; no store transaction id in what the player gets', async () => {
    const { svc } = await seeded();
    const page = await svc.history('u1', 'purchases') as { items: PurchaseRow[]; nextCursor: string | null; windowDays: number };
    expect(page.items.map((p) => p.productId)).toEqual(['coin_160', 'coin_1500', 'coin_480']);
    expect(page.items.map((p) => p.status)).toEqual(['test', 'refunded', 'completed']);
    expect(page.items[1]).toMatchObject({ product: 'コイン1,020', priceYen: 1500, store: 'fake', storeName: 'テスト', statusText: PURCHASE_STATUS_TEXT.refunded, paidCoins: 1020 });
    expect(page.items[2]!.ref).toBe(purchaseRef('fake:ORDER-1'));
    expect(page.items[2]!.ref).toMatch(/^P-[0-9A-F]{8}$/);
    expect(page.windowDays).toBe(m.progression.accountDeletion?.ledgerRetentionDays ?? 2557);
    expect(page.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/ORDER-|internal/);
  });

  it('a pending store subscription period reads as 確認中', async () => {
    const { svc, store, repo } = await setup();
    await svc.setAge('u2', 1990, 1, false);
    await svc.purchase('u2', 'fake', 'season_pass', store.issue({ transactionId: 'fake:SUB-1', productId: 'season_pass', purchasedAt: NOW, priceYen: 980, originalTransactionId: 'sub-a', expiresAt: NOW + 30 * DAY_MS }));
    await svc.subscriptionStatus('u2', 'fake', 'sub-a', 'billing_retry', NOW + 30 * DAY_MS);
    const page = await svc.history('u2', 'purchases') as { items: PurchaseRow[] };
    expect(page.items[0]).toMatchObject({ status: 'pending', statusText: PURCHASE_STATUS_TEXT.pending });
    expect(repo.data.size).toBe(1);
  });

  it('pages with an opaque cursor that does not shift when a purchase lands between two pages', async () => {
    const { svc, buy } = await seeded();
    const p1 = await svc.history('u1', 'purchases', { limit: 2 }) as { items: PurchaseRow[]; nextCursor: string | null };
    expect(p1.items.map((p) => p.productId)).toEqual(['coin_160', 'coin_1500']);
    expect(p1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await buy('u1', 'coin_800', 800);
    const p2 = await svc.history('u1', 'purchases', { limit: 2, cursor: p1.nextCursor }) as { items: PurchaseRow[]; nextCursor: string | null };
    expect(p2.items.map((p) => p.productId)).toEqual(['coin_480']);
    expect(p2.nextCursor).toBeNull();
    await expect(svc.history('u1', 'purchases', { cursor: encodeCursor('coins', 3) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.history('u1', 'purchases', { cursor: 'not-base64!' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.history('u1', 'purchases', { limit: 51 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.history('u1', 'purchases', { limit: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(decodeCursor('gacha', encodeCursor('gacha', 12))).toBe(12);
  });

  it('keeps purchases for the legal retention period only', async () => {
    const x = await seeded();
    const days = m.progression.accountDeletion?.ledgerRetentionDays ?? 2557;
    x.setNow(NOW + (days + 1) * DAY_MS);
    expect(((await x.svc.history('u1', 'purchases')) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('coin history (REQ-HIST-003/007/008)', () => {
  it('paid and free apart, earned / spent with a reason; the gacha, the purchase and the refund are named, never the raw reason', async () => {
    const { svc } = await seeded();
    const paid = await svc.history('u1', 'coins', { currency: 'paid', limit: 50 }) as { items: CoinRow[]; currency: string };
    expect(paid.currency).toBe('paid');
    expect(paid.items.every((r) => r.currency === 'paid')).toBe(true);
    const cats = paid.items.map((r) => r.category);
    expect(cats).toContain('purchase');
    expect(cats).toContain('gacha');
    expect(cats).toContain('refund');
    const buy480 = paid.items.find((r) => r.category === 'purchase' && r.title.includes('コイン310'))!;
    expect(buy480).toMatchObject({ direction: 'earned', amount: 310, title: 'コインの購入（コイン310）', purchaseRef: purchaseRef('fake:ORDER-1') });
    const ten = paid.items.find((r) => r.category === 'gacha' && r.title.startsWith('スカウト10回'))!;
    expect(ten).toMatchObject({ direction: 'spent', amount: 1000, title: 'スカウト10回（恒常ガチャ）' });
    expect('seq' in paid.items[0]!).toBe(false);

    const free = await svc.history('u1', 'coins', { currency: 'free', limit: 50 }) as { items: CoinRow[] };
    expect(free.items.every((r) => r.currency === 'free')).toBe(true);
    const comp = free.items.find((r) => r.category === 'compensation')!;
    expect(comp).toMatchObject({ direction: 'earned', amount: 50, title: COIN_TITLES.compensation });
    expect(free.items.map((r) => r.category)).toContain('purchase_test');
    // the operator's name, the reason they typed, the store order id: never in the player's view
    const all = JSON.stringify(await svc.history('u1', 'coins', { limit: 50 }));
    expect(all).not.toMatch(/ops-alice|outage|ORDER-|support grant|admin:|internal/);
  });

  it('pages by ledger sequence; rows older than 365 days drop out', async () => {
    const x = await seeded();
    const first = await x.svc.history('u1', 'coins', { limit: 3 }) as { items: CoinRow[]; nextCursor: string };
    const second = await x.svc.history('u1', 'coins', { limit: 3, cursor: first.nextCursor }) as { items: CoinRow[] };
    const seqs = [...first.items, ...second.items].map((r) => Number(r.ref.slice(2)));
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(new Set(seqs).size).toBe(6);
    x.setNow(NOW + 200 * DAY_MS);
    await x.buy('u1', 'coin_160', 160); // a new row in the window
    x.setNow(NOW + 366 * DAY_MS);
    const late = await x.svc.history('u1', 'coins', { limit: 50 }) as { items: CoinRow[] };
    expect(late.items.length).toBeGreaterThan(0);
    expect(late.items.every((r) => r.at === NOW + 200 * DAY_MS)).toBe(true);
    expect(late.items.map((r) => r.title)).toContain('コインの購入（コイン100）');
  });

  it('every reason the domain writes has a category (nothing player-visible falls through to the raw text)', () => {
    const reasons: [string, number][] = [
      ['purchase coin_480', 310], ['first purchase bonus coin_480', 310], ['sandbox purchase coin_160', 100], ['daily pack allowance_30 2026-11-09', 50],
      ['gacha standard x10 step 2', -1000], ['cosmetic tack_red', -300], ['rewarded ad home_coins', 10], ['support grant by ops-x: y', 100],
      ['beginner login bonus day 1', 10], ['login bonus day 3', 10], ['mission race1', 10], ['beginner mission b1', 10], ['season mission s1', 10],
      ['achievement wins tier 1', 10], ['race ranked place 1', 10], ['first win bonus #1', 10], ['time attack milestone m1', 10], ['pass free 3', 10],
      ['pass premium 3 (auto, season 2026-10 closed)', 10], ['season 2026-10 B rank 3', 10], ['team t1 season 2026-10 rank 2', 10], ['league 2026-10 d1 place 1 team t1', 10],
      ['event entry fee', -50], ['event entry fee refund', 50], ['event ev1 rank 2', 10], ['event ev1 100pt', 10], ['tournament t1 rank 1', 10], ['stud fee', -100], ['stud fee', 100],
      ['invite welcome gift', 10], ['invite milestone ranked10', 10], ['bond level 3', 10], ['comeback login cb1 day 1', 10], ['comeback mission cbm1', 10],
      ['store refund', -310], ['store refund (bonus)', -310], ['unsettled refund 40', 0], ['unsettled bonus refund 5', 0], ['debt settlement', -40], ['debt write-off 40: goodwill (ops)', 0], ['account deleted', -5],
    ];
    for (const [reason, delta] of reasons) {
      const c = classifyLedger(m, { reason, kind: delta < 0 ? 'spend' : 'grant', delta });
      expect(c.category, reason).not.toBe('other');
      expect(c.title, reason).not.toMatch(/[a-z]{3,}/); // no English reason / ids leak into the Japanese title
    }
    expect(classifyLedger(m, { reason: 'stud fee', kind: 'spend', delta: -1 }).title).toBe('種付け料の支払い');
    expect(classifyLedger(m, { reason: 'something new 123', kind: 'grant', delta: 1 })).toEqual({ category: 'other', title: 'その他の増減' });
    expect(classifyLedger(m, { reason: 'gacha retired_banner x1', kind: 'spend', delta: -100 }).title).toBe('スカウト1回');
  });
});

describe('gacha history (REQ-HIST-004/013)', () => {
  it('every draw is recorded: banner, results, coins used (paid / free), ticket and tutorial', async () => {
    const { svc } = await seeded();
    const page = await svc.history('u1', 'gacha') as { items: GachaRow[]; windowDays: number };
    expect(page.windowDays).toBe(90);
    expect(page.items.map((g) => g.via)).toEqual(['ticket', 'coins', 'coins', 'tutorial']);
    const [ticket, single, ten, tut] = page.items;
    expect(ticket).toMatchObject({ banner: '恒常ガチャ', bannerId: 'standard', count: 1, coins: { paid: 0, free: 0 }, viaText: 'スカウト券' });
    expect(single!.count).toBe(1);
    expect(ten!.count).toBe(10);
    expect(ten!.coins.paid + ten!.coins.free).toBe(1000);
    expect(ten!.results).toHaveLength(10);
    expect(ten!.summary).toMatch(/^(SSR \d+・)?(SR \d+・?)?(R \d+)?$/);
    expect(tut).toMatchObject({ via: 'tutorial', viaText: 'チュートリアル（無料）', coins: { paid: 0, free: 0 } });
    for (const r of ten!.results) expect(m.templateById.get(r.templateId)!.name).toBe(r.name);
  });

  it('records older than 90 days leave the list and the state; the state never holds more than the cap', async () => {
    const x = await seeded();
    x.setNow(NOW + 91 * DAY_MS);
    expect(((await x.svc.history('u1', 'gacha')) as { items: unknown[] }).items).toEqual([]);
    await x.buy('u1', 'coin_1500', 1500); // settles the refund debt
    await x.svc.draw('u1', 'standard', 1, 'c:late');
    const st = await x.svc.state('u1');
    expect(st.gachaLog!.entries.map((e) => e.via)).toEqual(['coins']);
    expect(st.gachaLog!.seq).toBe(5);
    const s = freshPlayer('cap', NOW);
    for (let i = 0; i < HISTORY_LIMITS.gachaKeep + 25; i++) recordGachaLog(s, NOW + i, { bannerId: 'standard', via: 'coins', count: 1, paid: 0, free: 100, results: [{ templateId: m.templates[0]!.id, rarity: 'R', duplicate: true }] });
    expect(s.gachaLog!.entries).toHaveLength(HISTORY_LIMITS.gachaKeep);
    expect(s.gachaLog!.entries[0]!.seq).toBe(26);
  });
});

describe('balance header (REQ-HIST-001)', () => {
  it('paid / free apart; this month against the age band limit', async () => {
    const { svc } = await seeded();
    const s = await svc.history('u1', 'summary') as any;
    const st = await svc.state('u1');
    expect(s.wallet).toEqual({ paid: st.wallet.paid, free: st.wallet.free, total: st.wallet.paid + st.wallet.free, debt: st.wallet.debt });
    expect(s).toMatchObject({ month: '2026-11', monthSpentYen: 1980, monthlyLimitYen: 5000, remainingYen: 3020, ageLimited: true, limitText: '今月の購入 ¥1,980 ／ 上限 ¥5,000（年齢に応じた月額上限）' });
    expect(s.windows).toEqual({ purchasesDays: m.progression.accountDeletion?.ledgerRetentionDays ?? 2557, coinsDays: 365, gachaDays: 90 });
    const { svc: svc2 } = await setup();
    await svc2.setAge('adult', 1990, 1, false);
    expect(await svc2.history('adult', 'summary')).toMatchObject({ monthlyLimitYen: null, remainingYen: null, ageLimited: false, limitText: null });
  });
});

describe('問い合わせ (REQ-HIST-009)', () => {
  it('a draft with the selected references and the player id only; unknown or foreign references are NOT_FOUND', async () => {
    const x = await seeded();
    const purchases = await x.svc.history('u1', 'purchases') as { items: PurchaseRow[] };
    const coins = await x.svc.history('u1', 'coins', { currency: 'free' }) as { items: CoinRow[] };
    const gacha = await x.svc.history('u1', 'gacha') as { items: GachaRow[] };
    const refs = [purchases.items[1]!.ref, coins.items[0]!.ref, gacha.items[0]!.ref];
    const t = await x.svc.historyTicket('u1', refs, 'refund');
    expect(t).toMatchObject({ format: 'muchi.support-ticket.v1', playerId: 'u1', topic: 'refund', topicText: SUPPORT_TOPIC_TEXT.refund, createdAt: NOW });
    expect(t.items.map((i) => i.kind)).toEqual(['purchase', 'coin', 'gacha']);
    expect(t.items[0]).toMatchObject({ title: 'コイン1,020', detail: '¥1,500・テスト・返金済み' });
    expect(t.body).toBe(`問い合わせ番号：${refs.join(' / ')}`);
    expect(Object.keys(t).sort()).toEqual(['body', 'createdAt', 'format', 'items', 'playerId', 'topic', 'topicText']);
    expect(JSON.stringify(t)).not.toMatch(/ORDER-|txId|ops-alice/);
    // another player's reference, an out-of-window one, a malformed one, duplicates
    await x.buy('u9', 'coin_160', 160);
    const theirs = ((await x.svc.history('u9', 'purchases')) as { items: PurchaseRow[] }).items[0]!.ref;
    await expect(x.svc.historyTicket('u1', [theirs], 'other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(x.svc.historyTicket('u1', ['C-99999'], 'coins')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(x.svc.historyTicket('u1', [refs[0]!, refs[0]!], 'other')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(x.svc.historyTicket('u1', [], 'other')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    x.setNow(NOW + 91 * DAY_MS);
    await expect(x.svc.historyTicket('u1', [refs[2]!], 'gacha')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // building a draft changes nothing
    const before = x.repo.data.get('u1');
    await x.svc.historyTicket('u1', [refs[0]!], 'refund');
    expect(x.repo.data.get('u1')).toBe(before);
  });
});

describe('deleted accounts (REQ-HIST-006)', () => {
  it('a wiped account has no history for the player or for support; the anonymised record is never reached', async () => {
    const x = await seeded();
    const ref = ((await x.svc.history('u1', 'purchases')) as { items: PurchaseRow[] }).items[0]!.ref;
    await x.svc.wipe('u1');
    for (const k of ['summary', 'purchases', 'coins', 'gacha'] as const) {
      await expect(x.svc.history('u1', k)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(x.svc.adminHistory('u1', k)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(x.svc.historyTicket('u1', [ref], 'refund')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(x.svc.adminHistoryRefs('u1', [ref])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(x.repo.data.has('u1')).toBe(false); // the reads never recreated a state
    const viaHttp = await x.get('u1', '/v1/history/purchases');
    expect(viaHttp.status).toBe(404);
    const ops = await x.admin('/v1/admin/players/u1/history?kind=purchases');
    expect(ops.status).toBe(404);
  });
  it('a player who never played gets empty lists (and no state is written)', async () => {
    const x = await setup();
    expect(await x.svc.history('nobody', 'gacha')).toMatchObject({ items: [], nextCursor: null });
    expect(x.repo.data.has('nobody')).toBe(false);
  });
});

describe('HTTP (REQ-HIST-005/008/010/011)', () => {
  it('player routes: validation, and English with no Japanese left and no banned wording', async () => {
    const x = await seeded();
    for (const p of ['/v1/history/summary', '/v1/history/purchases', '/v1/history/coins?currency=paid', '/v1/history/coins?currency=free&limit=50', '/v1/history/gacha']) {
      const ja = await x.get('u1', p);
      expect(ja.status, p).toBe(200);
      const en = await x.get('u1', p + (p.includes('?') ? '&' : '?') + 'lang=en');
      expect(en.status, p).toBe(200);
      expect(untranslated(en.body), p).toEqual([]);
      expect(enWordingProblems(JSON.stringify(en.body)), p).toEqual([]);
    }
    const en = (await x.get('u1', '/v1/history/coins?currency=paid&lang=en')).body;
    expect(en.items.find((r: CoinRow) => r.category === 'gacha').title).toMatch(/^Scout ×?\d+|^\d+ scouts?|Scout/);
    expect((await x.get('u1', '/v1/history/summary?lang=en')).body.limitText).toBe('This month: ¥1,980 of ¥5,000 (monthly limit for your age)');
    expect((await x.get('u1', '/v1/history/coins?currency=gold')).status).toBe(400);
    expect((await x.get('u1', '/v1/history/purchases?currency=paid')).status).toBe(400);
    expect((await x.get('u1', '/v1/history/gacha?limit=abc')).status).toBe(400);
    expect((await x.get('u1', '/v1/history/gacha?limit=99')).status).toBe(400);
    expect((await x.get('u1', '/v1/history/gacha?cursor=%3Cscript%3E')).status).toBe(400);
    expect((await x.get('u1', '/v1/history/ledger')).status).toBe(404);
    // the ticket over HTTP, in English too
    const ref = (await x.get('u1', '/v1/history/purchases')).body.items[0].ref;
    const t = await x.get('u1', '/v1/history/support-ticket?lang=en', { method: 'POST', body: { refs: [ref], topic: 'purchase_missing' } });
    expect(t.status).toBe(200);
    expect(untranslated(t.body)).toEqual([]);
    expect(t.body.topicText).toBe('Bought but not received');
    expect((await x.get('u1', '/v1/history/support-ticket', { method: 'POST', body: { refs: [ref], topic: 'refund', email: 'a@b.c' } })).status).toBe(400);
    expect((await x.get('u1', '/v1/history/support-ticket', { method: 'POST', body: { refs: ['fake:ORDER-1'], topic: 'refund' } })).status).toBe(400);
  });

  it('ops console: the same lists with the internal values, references lookup, read only and audited', async () => {
    const x = await seeded();
    const p = await x.admin('/v1/admin/players/u1/history?kind=purchases');
    expect(p.status).toBe(200);
    expect(p.body.items[1].internal).toMatchObject({ txId: 'fake:ORDER-2', platform: 'fake', sandbox: false });
    const c = await x.admin('/v1/admin/players/u1/history?kind=coins&currency=free&limit=50');
    expect(c.body.items.find((r: any) => r.category === 'compensation').internal.reason).toMatch(/ops-alice/);
    const s = await x.admin('/v1/admin/players/u1/history');
    expect(s.body.wallet).toBeDefined();
    const ref = p.body.items[0].ref;
    const look = await x.admin(`/v1/admin/players/u1/history?refs=${ref},C-99999`);
    expect(look.body.items.map((i: any) => i.kind)).toEqual(['purchase', null]);
    expect(look.body.items[0].row.internal.txId).toBe('fake:ORDER-3');
    expect((await x.admin('/v1/admin/players/u1/history?kind=ledger')).status).toBe(400);
    expect((await x.admin('/v1/admin/players/u1/history?refs=nope')).status).toBe(400);
    const audit = await x.ops.api.auditQuery({ limit: 50 });
    expect(audit.filter((a) => a.action === 'player.history.view' && a.target === 'player:u1').length).toBeGreaterThanOrEqual(4);
  });

  it('KPI: history_view is a client event with the tab', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'history_view', at: NOW, props: { tab: 'coins_paid' } }] });
    expect(clientToKpi(b.events[0]!)).toEqual({ name: 'history_view', s1: 'coins_paid' });
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'history_view', at: NOW, props: { tab: 'ledger' } }] }).success).toBe(false);
  });

  it('every history text has English (titles, statuses, topics, notices)', () => {
    const cat = catalogFor(m);
    const texts = [...Object.values(COIN_TITLES), ...Object.values(PURCHASE_STATUS_TEXT), ...Object.values(SUPPORT_TOPIC_TEXT), 'チュートリアル（無料）', '種付け料の支払い', '種付け料の受け取り'];
    expect(untranslated(localize(texts, 'en', cat))).toEqual([]);
  });
});
