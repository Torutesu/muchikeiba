import { describe, expect, it } from 'vitest';
import { atavismOdds, atavismOptions, breed, breedingPreview, createHorseFromTemplate, parentTraits, pedigree, inbreedingCount } from '../src/domain/horses.js';
import { bannerProblems, drawGacha, findBanner, oddsDisclosure, settlePityGroups } from '../src/domain/gacha.js';
import { applyEventResult, eventProblems } from '../src/domain/events.js';
import { expandPool, type Master } from '../src/domain/master.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { seededRng } from '../src/domain/rng.js';
import { grantFree } from '../src/domain/wallet.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { MemoryStudDirectory, retryStudOutbox, StudService, type StudPlayers } from '../src/domain/studService.js';
import { studConfigProblems, STUD_HARD_LIMITS } from '../src/domain/stud.js';
import { studPlayersFrom, handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { resolveBundle } from '../src/ops/config.js';
import { AppError } from '../src/domain/errors.js';
import type { HorseInstance, PlayerState } from '../src/domain/player.js';
import { freshPlayer, m } from './helpers.js';
import gachaJson from '../master/gacha.json';

const NOW = Date.UTC(2026, 10, 5, 3);
const tpl = (id: string) => m.templateById.get(id)!;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return (e as AppError).code; }
  return 'NO_ERROR';
};
const withProg = (patch: Partial<Master['progression']>): Master => ({ ...m, progression: { ...m.progression, ...patch } });
const retiredFrom = (s: PlayerState, id: string, at = NOW) => { const h = createHorseFromTemplate(s, tpl(id), at); h.status = 'retired'; return h; };

// ---------------------------------------------------------------- seasonal horses
describe('seasonal (季節限定) horses (REQ-BREED-020..023)', () => {
  const winter = findBanner(m, 'winter_2026');
  const se = tpl('t_seiya').seasonal!;

  it('permanent banners, the SR+ ticket table and CPU fill never offer a seasonal horse', () => {
    for (const id of ['standard', 'pickup_akatsuki', 'stepup_paid']) {
      const b = findBanner(m, id);
      expect([...b.pool, ...b.guaranteePool].some((e) => tpl(e.templateId).seasonal)).toBe(false);
    }
    expect(expandPool(m.templates, m.items.tickets.ticket_sr_plus!.kind === 'srPlus' ? (m.items.tickets.ticket_sr_plus as { rates: Record<string, number> }).rates : {}).some((e) => tpl(e.templateId).seasonal)).toBe(false);
    for (let seed = 1; seed <= 20; seed++) {
      const p = freshPlayer('tmp');
      const cfg = buildRaceConfig(m, { raceId: `r${seed}`, mode: 'ranked', trackId: 'kirameki_turf_2000', humans: [{ playerId: 'a', horse: toRaceHorse(m, createHorseFromTemplate(p, tpl('t_natsu'), 0)) }], cpuCount: 11, cpuLevel: 3, statCap: 3200, rng: seededRng(seed) });
      expect(cfg.entrants.some((e) => e.horse.name === 'セイヤノカネ' || e.horse.name === 'ハツユキソウ')).toBe(false);
    }
  });

  it('the seasonal banner offers them inside the window; odds are disclosed from the same table and marked limited', () => {
    expect(winter.pool.find((e) => e.templateId === 't_seiya')!.ppm).toBe(15000);
    expect(winter.pool.some((e) => e.templateId === 't_hatsuyuki')).toBe(true);
    expect(winter.pool.reduce((a, e) => a + e.ppm, 0)).toBe(1_000_000);
    const d = oddsDisclosure(m, winter);
    expect(d.period).toEqual({ startAtMs: winter.startAtMs, endAtMs: winter.endAtMs });
    expect(d.limitedNotice).toContain('入手済みの馬はそのまま');
    const row = d.items.find((r) => r.templateId === 't_seiya')!;
    expect(row).toMatchObject({ ppm: 15000, rate: '1.5000%', limited: { seasonId: 'winter_2026', label: '冬季限定', endAtMs: se.endAtMs } });
    expect(d.items.filter((r) => r.limited).map((r) => r.templateId).sort()).toEqual(['t_hatsuyuki', 't_seiya']);
    expect(oddsDisclosure(m, findBanner(m, 'standard')).limitedNotice).toBeNull();
    expect(d.pity).toMatchObject({ group: 'winter_2026', targets: ['t_seiya'] });
  });

  it('validation: a seasonal horse outside its window, or on a permanent pity group, is rejected', () => {
    expect(bannerProblems(winter, m, m.gacha)).toEqual([]);
    expect(bannerProblems({ ...winter, endAtMs: se.endAtMs + 1 }, m, m.gacha).join()).toMatch(/outside its window/);
    expect(bannerProblems({ ...winter, startAtMs: undefined }, m, m.gacha).join()).toMatch(/outside its window/);
    expect(bannerProblems({ ...winter, pityGroup: 'standard' }, m, m.gacha).join()).toMatch(/closing pity group/);
    // remote config can schedule it too, and the same checks apply
    const raw = { id: 'winter_x', name: 'x', currency: 'any', priceSingle: 100, priceTen: 1000, pityGroup: 'winter_2026', pityTargets: ['t_seiya'], seasonal: ['t_seiya'], pool: 'auto', rates: { SSR: 30000, SR: 180000, R: 790000 }, guaranteeRates: { SSR: 30000, SR: 970000 }, startAtMs: se.startAtMs - 1, endAtMs: winter.endAtMs };
    expect(() => resolveBundle(m, { gacha: { banners: [...(gachaJson as { banners: unknown[] }).banners, raw] } } as never)).toThrow(/outside its window/);
  });

  it('closed before and after the window; owned horses stay after it, and pity converts to the permanent pool', () => {
    const s = freshPlayer();
    grantFree(s, 5000, NOW, 'test', 't');
    expect(() => drawGacha(m, s, 'winter_2026', 10, seededRng(1), NOW)).toThrow(/BANNER_CLOSED/);
    const during = winter.startAtMs! + 1000;
    let got: HorseInstance | undefined;
    for (let seed = 1; seed < 400 && !got; seed++) {
      drawGacha(m, s, 'winter_2026', 1, seededRng(seed), during);
      got = s.horses.find((h) => h.templateId === 't_seiya' || h.templateId === 't_hatsuyuki');
      if (s.wallet.free < 100) grantFree(s, 5000, during, 'test', `t${seed}`);
    }
    expect(got).toBeDefined();
    expect(s.pity.winter_2026).toBeGreaterThan(0);
    const after = winter.endAtMs! + 1;
    expect(() => drawGacha(m, s, 'winter_2026', 1, seededRng(2), after)).toThrow(/BANNER_CLOSED/);
    const points = s.pity.winter_2026!;
    const before = s.pity.standard ?? 0;
    settlePityGroups(m, s, after);
    expect(s.pity.winter_2026 ?? 0).toBe(0);
    expect(s.pity.standard).toBe(before + points);
    // still owned, still raceable and breedable after the season
    expect(s.horses.some((h) => h.id === got!.id)).toBe(true);
    expect(toRaceHorse(m, got!).name).toBe(got!.name);
  });

  it('an event milestone can grant the seasonal horse (inside its window only)', () => {
    const ev = m.events.find((e) => e.id === 'no_whip_cup_2026_12')!;
    expect(eventProblems(m, [ev])).toEqual([]);
    const s = freshPlayer();
    const at = ev.startAtMs + 1000;
    s.events = { [ev.id]: { points: 1450, races: 5, wins: 0, milestones: [500], pending: { entryId: 'e1', at, fee: ev.fee }, closed: false, rank: null } } as never;
    const r = applyEventResult(ev, s, { raceId: 'r1', place: 1, void: false }, at, m);
    expect(r.milestones).toContainEqual({ horse: 't_hatsuyuki' });
    expect(s.horses.filter((h) => h.templateId === 't_hatsuyuki')).toHaveLength(1);
    // a horse reward without the template table cannot be silently dropped
    (s.events as Record<string, { milestones: number[]; pending: unknown }>)[ev.id]!.milestones = [500];
    (s.events as Record<string, { milestones: number[]; pending: unknown }>)[ev.id]!.pending = { entryId: 'e2', at, fee: ev.fee } as never;
    expect(() => applyEventResult(ev, s, { raceId: 'r2', place: 1, void: false }, at)).toThrow(/cannot be granted/);
    const outside = { ...ev, id: 'late_cup', endAtMs: tpl('t_hatsuyuki').seasonal!.endAtMs + 1 };
    expect(eventProblems(m, [outside]).join()).toMatch(/outside its window/);
    expect(eventProblems(m, [{ ...ev, milestones: [{ points: 10, reward: { horse: 't_nope' } }] }]).join()).toMatch(/unknown/);
  });
});

// ---------------------------------------------------------------- atavism
describe('atavism / 隔世遺伝 (REQ-BREED-017..019)', () => {
  /** sire's sire is a nige horse with a heavy-ground preference; parents are sashi/senko without one. */
  function family() {
    const s = freshPlayer();
    const gs = retiredFrom(s, 't_hatsuyuki'); // female nige, heavy → used as granddam
    gs.sex = 'female';
    const gsire = retiredFrom(s, 't_kurogane');
    const sire = retiredFrom(s, 't_natsu');
    sire.sireId = gsire.id; sire.damId = gs.id; sire.style = 'sashi'; delete sire.goingAptitude;
    const dam = retiredFrom(s, 't_yukimi');
    dam.style = 'senko'; delete dam.goingAptitude;
    return { s, sire, dam, gs };
  }

  it('candidates are the grandparents\' traits neither parent has; preview odds come from the same function', () => {
    const { s, sire, dam } = family();
    const opts = atavismOptions(sire, dam, [...parentTraits(s, sire), ...parentTraits(s, dam)]);
    expect(opts).toContainEqual({ trait: 'style', value: 'nige', from: 'ハツユキソウ' });
    expect(opts.find((o) => o.trait === 'goingAptitude')).toMatchObject({ value: 'heavy' });
    expect(opts.some((o) => o.value === sire.style || o.value === dam.style)).toBe(false);
    const p = breedingPreview(m, s, sire.id, dam.id);
    expect(p.atavism).toEqual(atavismOdds(m, opts));
    expect(p.atavism.chancePermille).toBe(m.progression.atavismPermille);
    expect(p.atavism.candidates.reduce((a, c) => a + c.permille, 0)).toBeCloseTo(m.progression.atavismPermille!, 6);
    // template horses (no parents in the stable) have nothing to pass on
    const t = freshPlayer();
    const a = retiredFrom(t, 't_natsu'); const b = retiredFrom(t, 't_yukimi');
    expect(breedingPreview(m, t, a.id, b.id).atavism).toEqual({ chancePermille: 0, candidates: [] });
  });

  it('breeding without candidates uses the RNG exactly as before (results unchanged)', () => {
    const run = (mm: Master) => {
      const t = freshPlayer();
      const a = retiredFrom(t, 't_natsu'); const b = retiredFrom(t, 't_yukimi');
      return breed(mm, t, a.id, b.id, seededRng(77), NOW).foal;
    };
    expect(run(withProg({ atavismPermille: 1000 }))).toEqual(run(withProg({ atavismPermille: 0 })));
  });

  it('a forced atavism changes only style or ground preference, never stats, and is recorded on the foal', () => {
    const { s, sire, dam } = family();
    const ref = structuredClone(s);
    const plain = breed(withProg({ atavismPermille: 0 }), ref, sire.id, dam.id, seededRng(5), NOW).foal;
    const r = breed(withProg({ atavismPermille: 1000 }), s, sire.id, dam.id, seededRng(5), NOW);
    expect(r.atavism).not.toBeNull();
    expect(r.foal.base).toEqual(plain.base);
    expect(r.foal.rarity).toBe(plain.rarity);
    const opts = atavismOptions(sire, dam, [...parentTraits(s, sire), ...parentTraits(s, dam)]);
    expect(opts).toContainEqual(r.foal.atavism);
    if (r.atavism!.trait === 'style') expect(r.foal.style).toBe(r.atavism!.value);
    else expect(r.foal.goingAptitude).toBe(r.atavism!.value);
  });

  it('the observed rate matches the shown chance', () => {
    let hits = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const { s, sire, dam } = family();
      if (breed(m, s, sire.id, dam.id, seededRng(1000 + i), NOW).atavism) hits++;
    }
    const expected = (m.progression.atavismPermille! / 1000) * N;
    expect(Math.abs(hits - expected)).toBeLessThan(4 * Math.sqrt(expected));
  });

  it('remote config cannot raise atavism or stud limits past the hard caps', () => {
    expect(studConfigProblems(m.progression)).toEqual([]);
    expect(studConfigProblems({ atavismPermille: STUD_HARD_LIMITS.atavismPermille + 1 }).join()).toMatch(/atavismPermille/);
    expect(studConfigProblems({ stud: { ...m.progression.stud!, feeMax: 10_000 } }).join()).toMatch(/feeMax/);
    expect(() => resolveBundle(m, { progression: { atavismPermille: 900 } } as never)).toThrow(/atavismPermille/);
  });
});

// ---------------------------------------------------------------- stud lending
interface World { svc: PlayerService; stud: StudService; dir: MemoryStudDirectory; ports: StudPlayers; clock: { now: number }; invoker: PlayerInvoker }

function world(opts: { failSettle?: () => boolean; failApply?: () => boolean } = {}): World {
  const clock = { now: NOW };
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(9), clock: () => clock.now, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const base = studPlayersFrom(() => invoker);
  const ports: StudPlayers = {
    ...base,
    settle: async (...a) => { if (opts.failSettle?.()) throw new Error('owner object unavailable'); return base.settle(...a); },
    apply: async (...a) => { if (opts.failApply?.()) throw new AppError('INSUFFICIENT_COINS'); return base.apply(...a); },
  };
  const dir = new MemoryStudDirectory();
  return { svc, stud: new StudService(ports, dir), dir, ports, clock, invoker };
}

/** owner "o" has a retired stallion; borrower "b" a retired mare and free coins; they are friends. */
async function setup(w: World, opts: { friends?: boolean; free?: number; paid?: number } = {}) {
  const stallion = await w.svc.tx('o', null, (s, now) => {
    const gs = retiredFrom(s, 't_hatsuyuki', now);
    const h = retiredFrom(s, 't_ginga', now);
    h.damId = gs.id;
    if (opts.friends !== false) s.friends.ids.push('b');
    return h;
  });
  const mare = await w.svc.tx('b', null, (s, now) => {
    const h = retiredFrom(s, 't_kohaku', now);
    h.style = 'sashi'; delete h.goingAptitude; // so the stallion's dam (nige) has something to pass on
    if (opts.free !== 0) grantFree(s, opts.free ?? 500, now, 'test', 'seed');
    if (opts.paid) { s.wallet.paid += opts.paid; s.wallet.lots.push({ id: 'lot1', amount: opts.paid, remaining: opts.paid, priceYenPerCoin: 1.6, at: now, txId: 'tx' } as never); }
    if (opts.friends !== false) s.friends.ids.push('o');
    return h;
  });
  return { stallion, mare };
}
const state = async (w: World, id: string) => w.svc.tx(id, null, (s) => structuredClone(s));

describe('stud lending (REQ-BREED-010..016)', () => {
  it('lists a retired stallion, shows it to friends (and publicly when public), never to its owner', async () => {
    const w = world();
    const { stallion } = await setup(w);
    expect(await code(w.stud.list('o', stallion.id, 'friends', 1000, 1))).toBe('BAD_REQUEST'); // above feeMax
    expect(await code(w.stud.list('o', stallion.id, 'friends', 50, 99))).toBe('BAD_REQUEST'); // above dailyLimitMax
    const e = await w.stud.list('o', stallion.id, 'friends', 50, 2);
    expect(e).toMatchObject({ ownerId: 'o', horseId: stallion.id, name: stallion.name, fee: 50, dailyLimit: 2, visibility: 'friends' });
    expect((await w.stud.browse('b', 'friends')).listings.map((x) => x.horseId)).toEqual([stallion.id]);
    expect((await w.stud.browse('b', 'public')).listings).toEqual([]);
    await w.stud.list('o', stallion.id, 'public', 50, 2);
    expect((await w.stud.browse('x', 'public')).listings.map((x) => x.ownerId)).toEqual(['o']);
    expect((await w.stud.browse('o', 'public')).listings).toEqual([]);
    // only retired stallions
    const active = await w.svc.tx('o', null, (s, now) => createHorseFromTemplate(s, tpl('t_natsu'), now));
    expect(await code(w.stud.list('o', active.id, 'public', 0, 1))).toBe('HORSE_NOT_RETIRED');
    const mare = await w.svc.tx('o', null, (s, now) => retiredFrom(s, 't_yukimi', now));
    expect(await code(w.stud.list('o', mare.id, 'public', 0, 1))).toBe('BREEDING_INVALID_PAIR');
    await w.stud.unlist('o', stallion.id);
    expect((await w.stud.browse('b', 'friends')).listings).toEqual([]);
  });

  it('breeds with a friend\'s stallion: fee in free coins, owner paid, owner keeps the horse, lineage on both sides', async () => {
    const w = world();
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'friends', 50, 2);
    const pv = (await w.stud.preview('b', 'o', stallion.id, mare.id)) as { stud: { fee: number; canPay: boolean; remainingToday: number }; stats: unknown; atavism: { candidates: unknown[] } };
    expect(pv.stud).toMatchObject({ fee: 50, canPay: true, remainingToday: 2 });
    expect(pv.atavism.candidates.length).toBeGreaterThan(0); // the stallion's dam is in the owner's stable
    const r = await w.stud.breed('b', 'o', stallion.id, mare.id, 'k1', false);
    expect(r.feeStatus).toBe('paid');
    expect(r.fee).toBe(50);
    const b = await state(w, 'b');
    const o = await state(w, 'o');
    expect(b.wallet.free).toBe(450);
    expect(b.wallet.paid).toBe(0);
    expect(o.wallet.free).toBe(50);
    expect(o.horses.find((h) => h.id === stallion.id)!.status).toBe('retired'); // still owned
    const foal = b.horses.find((h) => h.id === r.foal.id)!;
    expect(foal).toMatchObject({ sireId: null, sireName: stallion.name, damId: mare.id, studSire: { ownerId: 'o', horseId: stallion.id } });
    const ped = pedigree(b, foal.id, 3);
    expect(ped.sire!.key).toBe(`stud:o:${stallion.id}`);
    expect(ped.sire!.dam!.name).toBe(stallion.damName);
    expect(o.stud!.history[0]).toMatchObject({ role: 'lent', borrowerId: 'b', fee: 50, paid: 50, foalId: foal.id });
    expect(b.stud!.history[0]).toMatchObject({ role: 'borrowed', ownerId: 'o', fee: 50 });
    expect(b.stud!.outbox).toEqual([]);
    expect(b.breeding.count).toBe(1); // counts toward the daily breeding allowance
    // a mare from the stud foal's line meeting the same stallion again is seen as inbreeding
    const viaStud = { ...foal, sex: 'female' as const, status: 'retired' as const };
    expect(inbreedingCount(b, { ...stallion, id: `stud:o:${stallion.id}`, sireId: null, damId: null }, viaStud)).toBeGreaterThan(0);
  });

  it('a retried request (same key) never charges or pays twice', async () => {
    const w = world();
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'friends', 40, 3);
    const a = await w.stud.breed('b', 'o', stallion.id, mare.id, 'same', false);
    const again = await w.stud.breed('b', 'o', stallion.id, mare.id, 'same', false);
    expect(again.foal.id).toBe(a.foal.id);
    const b = await state(w, 'b');
    const o = await state(w, 'o');
    expect(b.wallet.free).toBe(460);
    expect(o.wallet.free).toBe(40);
    expect(b.horses.filter((h) => h.studSire)).toHaveLength(1);
    expect(o.stud!.history).toHaveLength(1);
  });

  it('a lost owner acknowledgement is retried from the borrower\'s outbox and pays exactly once', async () => {
    let down = true;
    const w = world({ failSettle: () => down });
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'public', 30, 2);
    const r = await w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false);
    expect(r.feeStatus).toBe('pending');
    let b = await state(w, 'b');
    expect(b.wallet.free).toBe(470); // charged once
    expect(b.stud!.outbox).toHaveLength(1);
    const retry = {
      settle: w.ports.settle, acked: w.ports.acked,
      due: (u: string) => w.svc.studDue(u), later: (u: string, op: string) => w.svc.studRetryLater(u, op),
    };
    w.clock.now += m.progression.stud!.retryMs;
    expect(await retryStudOutbox(retry, 'b')).toEqual({ attempted: 1, paid: 0 }); // still down → backs off
    b = await state(w, 'b');
    expect(b.stud!.outbox[0]!.attempts).toBe(1);
    expect(b.stud!.outbox[0]!.nextAt).toBeGreaterThan(w.clock.now);
    down = false;
    w.clock.now = b.stud!.outbox[0]!.nextAt;
    expect(await retryStudOutbox(retry, 'b')).toEqual({ attempted: 1, paid: 1 });
    expect(await retryStudOutbox(retry, 'b')).toEqual({ attempted: 0, paid: 0 });
    expect((await state(w, 'o')).wallet.free).toBe(30);
    // a duplicate settlement (e.g. the ack was lost after the owner paid) is a no-op
    expect(await w.ports.settle('o', r.opId, true, { borrowerId: 'b', horseId: stallion.id, fee: 30, foalId: r.foal.id })).toMatchObject({ status: 'already', paid: 0 });
    expect((await state(w, 'o')).wallet.free).toBe(30);
    expect((await state(w, 'b')).stud!.outbox).toEqual([]);
  });

  it('a failed breeding releases the reservation (nobody charged, the lend is free again)', async () => {
    let fail = true;
    const w = world({ failApply: () => fail });
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'friends', 10, 1);
    expect(await code(w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false))).toBe('INSUFFICIENT_COINS');
    expect(Object.keys((await state(w, 'o')).stud!.reservations)).toEqual([]);
    expect((await state(w, 'b')).wallet.free).toBe(500);
    fail = false;
    expect((await w.stud.breed('b', 'o', stallion.id, mare.id, 'k2', false)).feeStatus).toBe('paid');
  });

  it('an abandoned reservation expires and frees the daily slot', async () => {
    const w = world();
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'friends', 10, 1);
    await w.ports.reserve('o', 'stud:b:crashed', 'b', stallion.id); // the request died here
    expect(await code(w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false))).toBe('BREEDING_DAILY_LIMIT');
    w.clock.now += m.progression.stud!.reserveTtlMs + 1;
    expect((await w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false)).feeStatus).toBe('paid');
  });

  it('limits: per-horse daily lends, borrower per day, owner earn cap; friends-only and self-lending refused', async () => {
    const w = world();
    const { stallion, mare } = await setup(w, { free: 5000 });
    await w.stud.list('o', stallion.id, 'friends', 100, 1);
    expect(await code(w.stud.breed('o', 'o', stallion.id, mare.id, 'k', false))).toBe('NOT_ELIGIBLE');
    expect(await code(w.stud.breed('x', 'o', stallion.id, mare.id, 'k', false))).toBe('FORBIDDEN'); // not a friend
    expect(await code(w.stud.preview('x', 'o', stallion.id, mare.id))).toBe('FORBIDDEN');
    await w.svc.tx('b', null, (s) => { s.items.breeding_material = 5; });
    await w.stud.breed('b', 'o', stallion.id, mare.id, 'k1', false);
    expect(await code(w.stud.breed('b', 'o', stallion.id, mare.id, 'k2', true))).toBe('BREEDING_DAILY_LIMIT'); // horse booked
    // owner earn cap: fees above it are not paid out
    const ow = await w.svc.tx('o', null, (s) => { s.stud!.lends.earned = m.progression.stud!.dailyEarnCap - 30; return s.stud!.lends.earned; });
    await w.stud.list('o', stallion.id, 'friends', 100, 3);
    const before = (await state(w, 'o')).wallet.free;
    await w.stud.breed('b', 'o', stallion.id, mare.id, 'k3', true); // extra breeding with material
    const o = await state(w, 'o');
    expect(o.wallet.free - before).toBe(30);
    expect(o.stud!.lends.earned).toBe(ow + 30);
    expect(o.stud!.history.at(-1)).toMatchObject({ fee: 100, paid: 30 });
    // borrower: borrowPerDay
    expect(m.progression.stud!.borrowPerDay).toBe(2);
    expect(await code(w.stud.breed('b', 'o', stallion.id, mare.id, 'k4', true))).toBe('BREEDING_DAILY_LIMIT');
  });

  it('paid coins can never pay a stud fee (no paid-value transfer between players)', async () => {
    const w = world();
    const { stallion, mare } = await setup(w, { free: 0, paid: 1000 });
    await w.stud.list('o', stallion.id, 'friends', 50, 1);
    expect(((await w.stud.preview('b', 'o', stallion.id, mare.id)) as { stud: { canPay: boolean } }).stud.canPay).toBe(false);
    expect(await code(w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false))).toBe('INSUFFICIENT_COINS');
    const b = await state(w, 'b');
    expect(b.wallet.paid).toBe(1000);
    expect((await state(w, 'o')).wallet).toMatchObject({ paid: 0, free: 0 });
    // the owner never receives paid coins, even for a free stallion
    await w.stud.list('o', stallion.id, 'friends', 0, 1);
    expect((await w.stud.breed('b', 'o', stallion.id, mare.id, 'k2', false)).fee).toBe(0);
    expect((await state(w, 'o')).wallet).toMatchObject({ paid: 0, free: 0 });
  });

  it('the preview with a borrowed stallion uses the same baseline as the breeding', async () => {
    const w = world();
    const { stallion, mare } = await setup(w);
    await w.stud.list('o', stallion.id, 'friends', 0, 3);
    const pv = (await w.stud.preview('b', 'o', stallion.id, mare.id)) as { stats: Record<string, { min: number; max: number }> };
    const r = await w.stud.breed('b', 'o', stallion.id, mare.id, 'k', false);
    for (const [k, v] of Object.entries(r.foal.base)) {
      expect(v).toBeGreaterThanOrEqual(pv.stats[k]!.min);
      expect(v).toBeLessThanOrEqual(pv.stats[k]!.max);
    }
  });
});

describe('stud lending over HTTP', () => {
  it('routes list → browse → preview → breed (Idempotency-Key required) → mine', async () => {
    const w = world();
    const { stallion, mare } = await setup(w);
    const c = {
      master: m, authenticate: async (req: Request) => req.headers.get('x-test-user')!, player: () => w.invoker,
      friends: makeFriendsService(() => w.invoker, new MemoryDirectory()), stud: w.stud, clock: () => w.clock.now,
    } as unknown as AppContext;
    const call = async (method: string, path: string, user: string, body?: unknown, idem?: string) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user, ...(idem ? { 'idempotency-key': idem } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('PUT', `/v1/stud/listings/${stallion.id}`, 'o', { visibility: 'friends', fee: 20, dailyLimit: 2 })).body).toMatchObject({ horseId: stallion.id, fee: 20 });
    expect((await call('GET', '/v1/stud/browse?scope=friends', 'b')).body.listings).toHaveLength(1);
    expect((await call('GET', '/v1/stud/browse?scope=nope', 'b')).body.error.code).toBe('BAD_REQUEST');
    expect((await call('POST', '/v1/stud/preview', 'b', { ownerId: 'o', horseId: stallion.id, damId: mare.id })).body.stud.fee).toBe(20);
    expect((await call('POST', '/v1/stud/breed', 'b', { ownerId: 'o', horseId: stallion.id, damId: mare.id })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const r = await call('POST', '/v1/stud/breed', 'b', { ownerId: 'o', horseId: stallion.id, damId: mare.id }, 'abc');
    expect(r.body).toMatchObject({ feeStatus: 'paid', fee: 20, ownerId: 'o' });
    const mine = (await call('GET', '/v1/stud/mine', 'o')).body;
    expect(mine.listings[0]).toMatchObject({ horseId: stallion.id, lentToday: 1 });
    expect(mine.today).toMatchObject({ earned: 20 });
    expect(mine.history[0]).toMatchObject({ role: 'lent', borrowerId: 'b' });
    expect((await call('DELETE', `/v1/stud/listings/${stallion.id}`, 'o')).body).toEqual({ horseId: stallion.id, listed: false });
    // stud lending switched off in config → NOT_FOUND
    const off = { ...c, master: withProg({ stud: undefined }) } as AppContext;
    const res = await handle(new Request('https://x/v1/stud/mine', { headers: { 'x-test-user': 'o' } }), {}, off);
    expect(res.status).toBe(404);
  });
});
