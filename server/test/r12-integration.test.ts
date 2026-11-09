import { describe, expect, it } from 'vitest';
import { m, freshPlayer } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { RivalConfig } from '../src/domain/rival.js';
import { weekIdAt } from '../src/domain/rival.js';
import { MemoryRivalRegistry, RivalService, rivalPlayersFrom } from '../src/domain/rivalService.js';
import type { PlayerInvoker } from '../src/http/app.js';
import { deliverGift } from '../src/domain/giftBox.js';
import { coinShortfall } from '../src/domain/shortfall.js';
import { compileCatalog, translateText } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';

/**
 * Round 12 cross-feature checks: gift box (§26) × easy controls (§27) × weekly rival (§28) × coin shortfall (§29).
 */
const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST;
const DAY = 86_400_000;
const rc = m.progression.rival as RivalConfig;

function world(master: Master = m, start = jst(2026, 12, 8)) {
  let now = start;
  const kpi: KpiRecord[] = [];
  const reg = new MemoryRivalRegistry(() => master, () => now);
  let svcRef: PlayerService | null = null;
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svcRef as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svcRef, args)) as PlayerInvoker['invoke'] };
  const rival = new RivalService(() => master, rivalPlayersFrom(() => invoker), reg);
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, {
    master, rng: seededRng(5), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); },
    onRival: (u) => rival.apply(u),
  });
  svcRef = svc;
  let n = 0;
  const k = () => `c:t:${n++}`;
  const player = async (id: string, rating = 1500) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, id === 'a' ? 'アイボウ' : 'ハヤテ', k());
    const s = await svc.state(id);
    s.rating.r = rating;
    await repo.put(s);
  };
  let race = 0;
  const ranked = async (field: Record<string, number>, extra: Record<string, unknown> = {}) => {
    const raceId = `r${race++}`;
    const f = Object.entries(field).map(([playerId, place]) => ({ playerId, place }));
    for (const [pid, place] of Object.entries(field)) {
      await svc.applyRace(pid, { raceId, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: f.length, field: f, ...extra } as never);
    }
    return raceId;
  };
  return { svc, repo, reg, rival, kpi, k, player, ranked, now: () => now, at: (t: number) => { now = t; } };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

async function paired() {
  const w = world();
  await w.player('a', 1500);
  await w.player('b', 1520);
  await w.ranked({ a: 3, b: 5 });
  w.at(jst(2026, 12, 15));
  await w.rival.view('a'); await w.rival.view('b');
  return w;
}

describe('R12 decision: which grants go to the gift box (§26.1 × §28)', () => {
  it('the weekly rival reward is paid straight into the wallet (its week-result sheet is the claim screen), never boxed', async () => {
    const w = await paired();
    for (let i = 0; i < 3; i++) await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 21, 4, 0));
    const before = (await w.svc.state('a')).wallet.free;
    const v = await w.rival.view('a') as any;
    expect(v.result).toMatchObject({ outcome: 'win', freeCoins: rc.rewards.win.freeCoins });
    const s = await w.svc.state('a');
    expect(s.wallet.free - before).toBe(rc.rewards.win.freeCoins);
    expect((s.giftBox?.box ?? []).length).toBe(0);
    expect(s.ledger.at(-1)).toMatchObject({ currency: 'free', delta: rc.rewards.win.freeCoins, ref: 'rival:2026-12-14' });
  });
  it('an ops compensation in the same week goes to the box, not the wallet', async () => {
    const w = await paired();
    const before = (await w.svc.state('a')).wallet.free;
    await w.svc.adminGrant('a', { freeCoins: 50 }, 'maintenance', 'op', 'comp-1');
    const s = await w.svc.state('a');
    expect(s.wallet.free).toBe(before);
    expect(s.giftBox!.box).toHaveLength(1);
  });
});

describe('R12 gift box adversarial', () => {
  it('a re-delivered reward with the same ref is a no-op, including its horse part (REQ-BOX-008)', () => {
    const s = freshPlayer('p', jst(2026, 12, 8));
    const horse = m.templates.find((t) => t.rarity === 'R')!.id;
    const horses0 = s.horses.length;
    const d = { source: 'season' as const, ref: 'season:2026-11', reward: { freeCoins: 30, horse }, note: 'season 2026-11' };
    deliverGift(m, s, d, jst(2026, 12, 8));
    expect(s.horses.length).toBe(horses0 + 1);
    const again = deliverGift(m, s, d, jst(2026, 12, 8) + 1000);
    expect(again).toMatchObject({ status: 'boxed', duplicate: true });
    expect(s.horses.length).toBe(horses0 + 1);
    expect(s.giftBox!.box).toHaveLength(1);
  });
  it('claim-one, claim-all and replays pay each gift exactly once (the player object serializes requests)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    for (let i = 0; i < 3; i++) await w.svc.adminGrant('p', { freeCoins: 10 + i }, 'g', 'op', `g${i}`);
    const free0 = (await w.svc.state('p')).wallet.free;
    const ids = (await w.svc.state('p')).giftBox!.box.map((e) => e.id);
    const one = await w.svc.giftClaim('p', ids[0]!, 'c:one');
    const all = await w.svc.giftClaimAll('p', 'c:all');
    expect(one.claimed.map((x) => x.giftId)).toEqual([ids[0]]);
    expect(all.claimed.map((x) => x.giftId).sort()).toEqual([ids[1], ids[2]].sort());
    expect(await code(w.svc.giftClaim('p', ids[0]!, 'c:one-again'))).toBe('ALREADY_CLAIMED');
    // replaying the keys returns the stored answers and pays nothing more
    expect(await w.svc.giftClaim('p', ids[0]!, 'c:one')).toEqual(one);
    expect(await w.svc.giftClaimAll('p', 'c:all')).toEqual(all);
    expect((await w.svc.giftClaimAll('p', 'c:all-2')).claimed).toEqual([]);
    const s = await w.svc.state('p');
    expect(s.wallet.free - free0).toBe(10 + 11 + 12);
    expect(s.giftBox!.box).toHaveLength(0);
  });
  it('expiry at the boundary: claimable 1 ms before expiresAt, expired at expiresAt (badge, list and claim agree)', async () => {
    const w = world(m, jst(2026, 12, 8, 3, 59));
    await w.svc.bootstrap('p');
    await w.svc.adminGrant('p', { freeCoins: 10 }, 'g', 'op', 'g1');
    await w.svc.adminGrant('p', { freeCoins: 20 }, 'g', 'op', 'g2');
    const [e1, e2] = (await w.svc.state('p')).giftBox!.box;
    expect(e1!.expiresAt).toBe(jst(2026, 12, 8, 3, 59) + 30 * DAY);
    w.at(e1!.expiresAt! - 1);
    expect((await w.svc.view('p') as any).giftBox).toMatchObject({ unclaimed: 2 });
    expect((await w.svc.giftClaim('p', e1!.id, 'c:a')).claimed).toHaveLength(1);
    w.at(e2!.expiresAt!);
    expect((await w.svc.view('p') as any).giftBox).toMatchObject({ unclaimed: 0 });
    expect((await w.svc.giftBox('p')).entries).toHaveLength(0);
    expect(await code(w.svc.giftClaim('p', e2!.id, 'c:b'))).toBe('GIFT_EXPIRED');
  });
  it('paid coins can never be boxed: a reward with paid coins puts only the free part in', () => {
    const s = freshPlayer('p', jst(2026, 12, 8));
    deliverGift(m, s, { source: 'event', ref: 'event:x', reward: { freeCoins: 5, paidCoins: 999 } as never, note: 'x' }, jst(2026, 12, 8));
    expect(s.giftBox!.box[0]!.contents).toEqual({ freeCoins: 5 });
    expect(s.wallet.paid).toBe(0);
  });
});

describe('R12 coin shortfall × gift box (§29 × §26)', () => {
  it('free coins waiting in the box are not counted as owned; the sheet says they are there (any / free coins only)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.adminGrant('p', { freeCoins: 700 }, 'g', 'op', 'g1');
    const s = await w.svc.state('p');
    const r = coinShortfall(m, s, { coinKind: 'any', need: s.wallet.paid + s.wallet.free + 500 }, w.now());
    expect(r.shortfall).toBe(500);
    expect(r.notes).toContain('プレゼントボックスに受け取っていない無償コインが700枚あります（受け取ると使えます）');
    // paid-only payments: the box cannot help, nothing is said about it
    const p = coinShortfall(m, s, { coinKind: 'paid', need: 500 }, w.now());
    expect(p.notes.join()).not.toMatch(/プレゼントボックス/);
    // English
    const cat = compileCatalog(m.locale?.en, CODE_EN);
    expect(r.notes.map((t) => translateText(t, cat)).join(' ')).toMatch(/700 free coins are waiting in your gift box/);
    // after claiming there is nothing more to say
    await w.svc.giftClaimAll('p', 'c:x');
    const s2 = await w.svc.state('p');
    expect(coinShortfall(m, s2, { coinKind: 'any', need: s2.wallet.paid + s2.wallet.free + 1 }, w.now()).notes.join()).not.toMatch(/プレゼントボックス/);
  });
});

describe('R12 rival × easy controls (§28 × §27)', () => {
  it('an assisted ranked race scores head to head like any other; nothing of the assist reaches the rival', async () => {
    const w = await paired();
    await w.ranked({ a: 1, b: 2 }, { details: { assist: 'full' } });
    const vb = await w.rival.view('b') as any;
    expect(vb.score).toMatchObject({ me: 0, them: 1 });
    expect(JSON.stringify(vb)).not.toMatch(/assist|whip|full/);
  });
});

describe('R12 rival week boundary (04:00 JST Monday)', () => {
  it('03:59 Monday still belongs to the old week; 04:00 is the new one', () => {
    expect(weekIdAt(m, jst(2026, 12, 21, 3, 59))).toBe('2026-12-14');
    expect(weekIdAt(m, jst(2026, 12, 21, 4, 0))).toBe('2026-12-21');
  });
  it('a race at 03:59 Monday scores in the ending week; one at 04:00 in the new week', async () => {
    const w = await paired();
    w.at(jst(2026, 12, 21, 3, 59));
    for (let i = 0; i < 3; i++) await w.ranked({ a: 1, b: 2 });
    w.at(jst(2026, 12, 21, 4, 0));
    await w.ranked({ a: 2, b: 1 });
    const v = await w.rival.view('a') as any;
    expect(v.result).toMatchObject({ weekId: '2026-12-14', me: 3, them: 0, outcome: 'win' });
  });
});

describe('R12 account deletion clears the gift box, the assist setting and the rival registrations', () => {
  it('after the wipe nothing of the three remains for the id', async () => {
    const w = await paired();
    await w.svc.setAssist('a', 'full', 'settings');
    await w.svc.adminGrant('a', { freeCoins: 10 }, 'g', 'op', 'g1');
    const t = (await w.svc.requestDeletion('a', null)) as { confirmToken: string };
    await w.svc.requestDeletion('a', t.confirmToken);
    expect(w.reg.store('2026-12-14').withdrawnSet.has('a')).toBe(true);
    await w.svc.deletionStart('a');
    const rec = await w.svc.deletionFinalize('a');
    expect(rec.forfeited.gifts).toMatchObject({ entries: 1, freeCoins: 10 });
    await w.reg.forget('2026-12-14', 'a');
    await w.reg.forget('2026-12-07', 'a');
    await w.svc.wipe('a');
    expect(await w.repo.get('a')).toBeNull();
    expect(w.reg.store('2026-12-14').entries.has('a')).toBe(false);
    expect(w.reg.store('2026-12-07').entries.has('a')).toBe(false);
    // the rival sees the pair dissolved
    expect((await w.rival.view('b') as any).rival).toMatchObject({ dissolved: true, card: null });
  });
});
