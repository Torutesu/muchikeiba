import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, tournamentPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { helpFold } from '../src/domain/help.js';
import {
  applyRosterQuery, aptitudeFor, bulkReasons, DEFAULT_QUERY, foldSearch, ROSTER_LIMITS, type RosterQuery, type RosterRow,
} from '../src/domain/roster.js';
import { TournamentsService, type TournamentBackend } from '../src/domain/tournamentService.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 9, 3);
const DAY = 86_400_000;
const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'roster-query.vectors.json');

function world() {
  const clock = { now: NOW };
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(5), clock: () => clock.now, verifiers: {},
    onKpi: (_id, recs) => { kpi.push(...recs); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, clock, kpi, invoker, repo };
}
type W = ReturnType<typeof world>;
async function horses(w: W, id: string, n: number, opts: { partnerFirst?: boolean } = {}) {
  return w.svc.tx(id, null, (s, now) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(createHorseFromTemplate(s, m.templates[i % m.templates.length]!, now + i).id);
    if (opts.partnerFirst) s.flags.partnerHorseId = ids[0];
    return ids;
  });
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;

describe('厩舎の整理: lock and favourite (REQ-ORG-005)', () => {
  it('value replacements, idempotent; a locked horse cannot be retired (single) — server enforced', async () => {
    const w = world();
    const [a, b] = await horses(w, 'p', 2);
    expect(await w.svc.rosterLock('p', a!, true)).toEqual({ horseId: a, locked: true });
    expect(await w.svc.rosterLock('p', a!, true)).toEqual({ horseId: a, locked: true });
    expect((await st(w, 'p')).roster!.locked).toEqual([a]);
    expect(await code(w.svc.retire('p', a!))).toBe('HORSE_LOCKED');
    expect((await st(w, 'p')).horses.find((h) => h.id === a)!.status).toBe('active');
    await w.svc.rosterLock('p', a!, false);
    expect((await w.svc.retire('p', a!)).status).toBe('retired');
    await w.svc.rosterFavorite('p', b!, true);
    await w.svc.rosterFavorite('p', b!, true);
    expect((await st(w, 'p')).roster!.favorites).toEqual([b]);
    expect(await code(w.svc.rosterLock('p', 'h999', true))).toBe('HORSE_NOT_FOUND');
    // breeding does not consume horses, so a lock never blocks it (retired parents stay)
    const v = await w.svc.roster('p');
    expect(v).toMatchObject({ total: 2, active: 1, retired: 1, locked: 0, favorites: 1, bulkMax: 50, actions: ['retire'] });
  });
});

describe('厩舎の整理: rows and query (REQ-ORG-001..003)', () => {
  it('rows carry rating (awakening + training), races from the career, age in game days and the blocks', async () => {
    const w = world();
    const [a] = await horses(w, 'p', 3, { partnerFirst: true });
    await w.svc.tx('p', null, (s) => {
      const h = s.horses[1]!;
      h.awakening = 2;
      h.trained = { speed: 10, stamina: 0, burst: 0, guts: 0, temper: 5 } as never;
    });
    w.clock.now += 3 * DAY;
    const v = await w.svc.roster('p');
    const r1 = v.horses.find((r) => r.horseId === 'h2')!;
    const base = Object.values((await st(w, 'p')).horses[1]!.base).reduce((x, y) => x + y, 0);
    expect(r1.rating).toBeGreaterThan(base + 15 - 1);
    expect(r1.ageDays).toBe(3);
    const p = v.horses.find((r) => r.horseId === a)!;
    expect(p).toMatchObject({ partner: true, blocks: ['partner'] });
    expect(v.partnerHorseId).toBe(a);
    expect(v.notice).toBe('まとめて引退しても、コインや素材は返ってきません');
  });

  it('server query = the shared rules; bad values are 400; aptitude needs a course', async () => {
    const w = world();
    await horses(w, 'p', 8);
    await w.svc.rosterFavorite('p', 'h3', true);
    const def = await w.svc.roster('p');
    expect(def.horses[0]!.horseId).toBe('h3'); // favourites first, then newest first
    expect(def.horses.slice(1).map((r) => r.horseId)).toEqual(['h8', 'h7', 'h6', 'h5', 'h4', 'h2', 'h1']);
    const byRating = await w.svc.roster('p', { sort: 'rating', dir: 'asc', favoritesFirst: '0' });
    const ratings = byRating.horses.map((r) => r.rating);
    expect([...ratings].sort((x, y) => x - y)).toEqual(ratings);
    const turf = await w.svc.roster('p', { surface: 'turf' });
    expect(turf.horses.every((r) => r.surface !== 'dirt')).toBe(true);
    expect(await code(w.svc.roster('p', { sort: 'aptitude' }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.roster('p', { sort: 'speed' }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.roster('p', { trackId: 'nowhere' }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.roster('p', { q: 'x'.repeat(21) }))).toBe('BAD_REQUEST');
    const apt = await w.svc.roster('p', { sort: 'aptitude', trackId: 'aoba_turf_1600', going: 'soft' });
    expect(apt.horses.length).toBe(8);
  });

  it('aptitude follows the engine conditions (surface, distance range, ground preference)', () => {
    const c = { surface: 'turf' as const, distanceM: 2000, going: 'soft' as const };
    expect(aptitudeFor({ surface: 'turf', distMinM: 1800, distMaxM: 2400, goingAptitude: 'heavy' }, c)).toMatchObject({ score: 450, mark: '◎' });
    expect(aptitudeFor({ surface: 'both', distMinM: 1800, distMaxM: 2400, goingAptitude: 'fast' }, c)).toMatchObject({ score: 350, mark: '○' });
    expect(aptitudeFor({ surface: 'dirt', distMinM: 1000, distMaxM: 1400, goingAptitude: 'any' }, c)).toMatchObject({ score: 0, mark: '×' });
    expect(aptitudeFor({ surface: 'turf', distMinM: 1000, distMaxM: 1600, goingAptitude: 'any' }, c)).toMatchObject({ score: 200, mark: '△' });
    expect(aptitudeFor({ surface: 'turf', distMinM: 1000, distMaxM: 1600, goingAptitude: 'any' }, { ...c, going: null }).score).toBe(200);
    expect(aptitudeFor({ surface: 'turf', distMinM: 1000, distMaxM: 1800, goingAptitude: 'any' }, c).score).toBe(300); // 200 m outside → 200 − 100
  });

  it('search folds hiragana / width / spaces / long-vowel marks', () => {
    expect(foldSearch('みどり')).toBe(foldSearch('ミドリ'));
    expect(foldSearch('ﾐﾄﾞﾘ')).toBe(foldSearch('ミドリ'));
    expect(foldSearch('ミドリ ノ カゼ')).toBe('ミドリノカゼ');
    expect(foldSearch('ハヤテ-')).toBe(foldSearch('ハヤテー'));
    // Round 17 integration: one search fold — the roster folds names like the help center (long vowels, small kana)
    for (const x of ['ハヤテー', 'ヴィクトリー', 'ﾁｮｺ', 'ＡＢＣ', 'みどり の かぜ']) expect(foldSearch(x), x).toBe(helpFold(x));
    expect(foldSearch('チョコ')).toBe(foldSearch('チヨコ'));
  });

  it('shared vectors (contracts/roster-query.vectors.json) — the C# RosterSorter reads the same file', () => {
    const v = vectors();
    if (process.env.UPDATE_VECTORS === '1') writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
    const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ReturnType<typeof vectors>;
    for (const c of file.cases) expect(applyRosterQuery(file.rows as RosterRow[], c.query as RosterQuery).map((r) => r.horseId), c.name).toEqual(c.expect);
    expect(file).toEqual(v);
  });
});

/** The vector set: 10 rows covering every field, and one case per sort key / filter / search. */
function vectors() {
  const row = (i: number, o: Partial<RosterRow>): RosterRow => ({
    horseId: `h${i}`, name: 'ウマ', templateId: null, rarity: 'R', sex: 'male', style: 'senko', surface: 'turf', distMinM: 1600, distMaxM: 2000,
    goingAptitude: 'any', status: 'active', rating: 2000, skillId: null, partner: false, locked: false, favorite: false,
    acquiredSeq: i, bornAt: 0, ageDays: 0, races: 0, wins: 0, blocks: [], ...o,
  });
  const rows = [
    row(1, { name: 'アイボウ', rarity: 'SR', partner: true, rating: 2600, races: 30, ageDays: 40, skillId: 'sk_sueashi', style: 'sashi' }),
    row(2, { name: 'ミドリノカゼ', rarity: 'SSR', rating: 3100, races: 12, ageDays: 30, surface: 'both', distMinM: 1800, distMaxM: 2400, goingAptitude: 'heavy', favorite: true }),
    row(3, { name: 'ハヤテ', rarity: 'R', rating: 2100, races: 12, ageDays: 30, surface: 'dirt', distMinM: 1000, distMaxM: 1400, style: 'nige' }),
    row(4, { name: 'ハヤテボシ', rarity: 'SR', rating: 2600, races: 3, ageDays: 20, status: 'retired', locked: true }),
    row(5, { name: 'ゴールドラッシュ', rarity: 'SSR', rating: 2950, races: 0, ageDays: 5, distMinM: 2400, distMaxM: 3200, goingAptitude: 'fast', style: 'oikomi', skillId: 'sk_x' }),
    row(6, { name: 'アカツキ', rarity: 'R', rating: 1800, races: 8, ageDays: 18, surface: 'dirt', distMinM: 1600, distMaxM: 1800 }),
    row(7, { name: 'ヨゾラ', rarity: 'SR', rating: 2400, races: 8, ageDays: 18, distMinM: 1200, distMaxM: 1600, favorite: true, locked: true }),
    row(8, { name: 'ミメイ', rarity: 'R', rating: 1500, races: 0, ageDays: 0, status: 'retired', surface: 'both', distMinM: 1400, distMaxM: 2000 }),
    row(9, { name: 'キナコ', rarity: 'SSR', rating: 3100, races: 50, ageDays: 60, goingAptitude: 'heavy' }),
    row(10, { name: 'シラナミ', rarity: 'R', rating: 2000, races: 2, ageDays: 2, distMinM: 2000, distMaxM: 2600, style: 'sashi' }),
  ];
  const q = (o: Partial<RosterQuery>): RosterQuery => ({ ...DEFAULT_QUERY, ...o });
  const turf2000soft = { surface: 'turf' as const, distanceM: 2000, going: 'soft' as const };
  const casesIn: [string, RosterQuery][] = [
    ['default (favourites first, newest first)', q({})],
    ['no favourites first', q({ favoritesFirst: false })],
    ['rating desc', q({ sort: 'rating', favoritesFirst: false })],
    ['rating asc', q({ sort: 'rating', dir: 'asc', favoritesFirst: false })],
    ['aptitude turf 2000 soft', q({ sort: 'aptitude', course: turf2000soft, favoritesFirst: false })],
    ['aptitude dirt 1400 no going', q({ sort: 'aptitude', course: { surface: 'dirt', distanceM: 1400, going: null }, favoritesFirst: false })],
    ['aptitude turf 2400 firm', q({ sort: 'aptitude', course: { surface: 'turf', distanceM: 2400, going: 'firm' }, favoritesFirst: false })],
    ['age desc', q({ sort: 'age', favoritesFirst: false })],
    ['acquired asc', q({ sort: 'acquired', dir: 'asc', favoritesFirst: false })],
    ['races desc', q({ sort: 'races' })],
    ['rarity desc', q({ sort: 'rarity', favoritesFirst: false })],
    ['name asc', q({ sort: 'name', dir: 'asc', favoritesFirst: false })],
    ['surface turf', q({ surface: 'turf', favoritesFirst: false })],
    ['surface dirt', q({ surface: 'dirt', favoritesFirst: false })],
    ['band sprint', q({ band: 'sprint', favoritesFirst: false })],
    ['band mile', q({ band: 'mile', favoritesFirst: false })],
    ['band intermediate', q({ band: 'intermediate', favoritesFirst: false })],
    ['band long', q({ band: 'long', favoritesFirst: false })],
    ['style sashi', q({ style: 'sashi', favoritesFirst: false })],
    ['active', q({ status: 'active', favoritesFirst: false })],
    ['retired', q({ status: 'retired', favoritesFirst: false })],
    ['has skill', q({ skill: true, favoritesFirst: false })],
    ['no skill', q({ skill: false, favoritesFirst: false })],
    ['partner', q({ partner: true })],
    ['locked', q({ locked: true, favoritesFirst: false })],
    ['not locked', q({ locked: false, favoritesFirst: false })],
    ['favourite', q({ favorite: true, favoritesFirst: false })],
    ['search はやて', q({ q: 'はやて', favoritesFirst: false })],
    ['search ﾐ (half width)', q({ q: 'ﾐ', favoritesFirst: false })],
    ['search no match', q({ q: 'ZZZ' })],
    ['combined: active turf by rating', q({ status: 'active', surface: 'turf', sort: 'rating' })],
  ];
  return {
    _note: 'REQ-ORG-002/003 (contracts/protocol.md §44.3): server/src/domain/roster.ts applyRosterQuery and C# Muchi.Client RosterSorter.Apply must give the same order. Regenerate with UPDATE_VECTORS=1 npx vitest run test/roster.test.ts.',
    rows, cases: casesIn.map(([name, query]) => ({ name, query, expect: applyRosterQuery(rows, query).map((r) => r.horseId) })),
  };
}

describe('厩舎の整理: bulk retire (REQ-ORG-006..011)', () => {
  it('preview lists every horse with reasons and a zero refund; changes nothing', async () => {
    const w = world();
    const ids = await horses(w, 'p', 4, { partnerFirst: true });
    await w.svc.rosterLock('p', ids[1]!, true);
    const before = JSON.stringify(await st(w, 'p'));
    const pv = await w.svc.rosterPreview('p', 'retire', [ids[0]!, ids[1]!, ids[2]!, 'h99']);
    expect(pv).toMatchObject({ action: 'retire', count: 4, eligible: 1, refused: 3, canConfirm: false, refund: { paidCoins: 0, freeCoins: 0, materials: {}, items: {} } });
    expect(pv.horses.map((h) => [h.horseId, h.reasons])).toEqual([[ids[0], ['partner']], [ids[1], ['locked']], [ids[2], []], ['h99', ['not_found']]]);
    expect(JSON.stringify(await st(w, 'p'))).toBe(before);
    expect(await code(w.svc.rosterPreview('p', 'retire', [ids[2]!, ids[2]!]))).toBe('BAD_REQUEST');
  });

  it('all or nothing: one refused horse → ROSTER_BULK_REFUSED with reasons, nobody retired', async () => {
    const w = world();
    const ids = await horses(w, 'p', 3);
    await w.svc.rosterLock('p', ids[2]!, true);
    const pv = await w.svc.rosterPreview('p', 'retire', ids);
    let err: AppError | null = null;
    try { await w.svc.rosterBulk('p', 'retire', ids, pv.confirmToken, 'c:k1'); } catch (e) { err = e as AppError; }
    expect(err?.code).toBe('ROSTER_BULK_REFUSED');
    expect(err?.details).toEqual({ horses: [{ horseId: ids[2], name: expect.any(String), ok: false, reasons: ['locked'] }] });
    expect((await st(w, 'p')).horses.every((h) => h.status === 'active')).toBe(true);
    // the refused key is not recorded: after fixing it the same key may run
    await w.svc.rosterLock('p', ids[2]!, false);
    const pv2 = await w.svc.rosterPreview('p', 'retire', ids);
    const r = await w.svc.rosterBulk('p', 'retire', ids, pv2.confirmToken, 'c:k1');
    expect(r).toMatchObject({ action: 'retire', count: 3, refund: { paidCoins: 0, freeCoins: 0 } });
  });

  it('runs the single-horse rule per horse (one ceremony each), keyed (a resend never retires twice), KPI once; wallet unchanged', async () => {
    const w = world();
    const ids = await horses(w, 'p', 3);
    const wallet = JSON.stringify((await st(w, 'p')).wallet);
    const materials = JSON.stringify((await st(w, 'p')).materials);
    const pv = await w.svc.rosterPreview('p', 'retire', [ids[0]!, ids[1]!]);
    const r = await w.svc.rosterBulk('p', 'retire', [ids[0]!, ids[1]!], pv.confirmToken, 'c:bulk-1');
    expect(r.horses.map((h) => h.horseId)).toEqual([ids[0], ids[1]]);
    expect(r.horses.every((h) => h.ceremony !== null)).toBe(true);
    const again = await w.svc.rosterBulk('p', 'retire', [ids[0]!, ids[1]!], pv.confirmToken, 'c:bulk-1');
    expect(again).toEqual(JSON.parse(JSON.stringify(r)));
    const s = await st(w, 'p');
    expect(s.horses.map((h) => h.status)).toEqual(['retired', 'retired', 'active']);
    expect(Object.keys(s.hall!.ceremonies).sort()).toEqual([ids[0], ids[1]].sort());
    expect(JSON.stringify(s.wallet)).toBe(wallet);
    expect(JSON.stringify(s.materials)).toBe(materials);
    expect(w.kpi.filter((k) => k.name === 'roster_bulk_action')).toMatchObject([{ s1: 'retire', count: 2 }]);
    // a new key on the same (now retired) horses is refused per horse; ceremonies not yet seen also block
    const pv3 = await w.svc.rosterPreview('p', 'retire', [ids[0]!]);
    expect(pv3.horses[0]!.reasons).toEqual(['not_active', 'hall_pending']);
    expect(await code(w.svc.rosterBulk('p', 'retire', [ids[0]!], pv3.confirmToken, 'c:bulk-2'))).toBe('ROSTER_BULK_REFUSED');
    expect(await code(w.svc.rosterBulk('p', 'retire', [ids[2]!], pv.confirmToken, 'c:bulk-3'))).toBe('ROSTER_BULK_STALE');
    expect(await code(w.svc.rosterBulk('p', 'retire', [ids[2]!], undefined, 'c:bulk-4'))).toBe('ROSTER_BULK_STALE');
    expect(await code(w.svc.rosterBulk('p', 'retire', [ids[2]!], 'x', null))).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('a change after the preview makes the token stale (lock toggled in between)', async () => {
    const w = world();
    const ids = await horses(w, 'p', 2);
    const pv = await w.svc.rosterPreview('p', 'retire', ids);
    await w.svc.rosterLock('p', ids[0]!, true);
    await w.svc.rosterLock('p', ids[0]!, false);
    expect((await w.svc.rosterPreview('p', 'retire', ids)).confirmToken).toBe(pv.confirmToken); // same state → same token
    await w.svc.tx('p', null, (s, now) => { createHorseFromTemplate(s, m.templates[0]!, now); });
    expect((await w.svc.rosterPreview('p', 'retire', ids)).confirmToken).toBe(pv.confirmToken); // other horses don't matter
    await w.svc.retire('p', ids[1]!);
    expect(await code(w.svc.rosterBulk('p', 'retire', ids, pv.confirmToken, 'c:k'))).toBe('ROSTER_BULK_REFUSED');
  });

  it('every refusal reason: on loan, in training, tournament entry (until the start + 24 h, cleared on unregister / close)', async () => {
    const w = world();
    const ids = await horses(w, 'p', 4);
    await w.svc.tx('p', null, (s, now) => {
      s.stud = { listings: [{ horseId: ids[0]!, visibility: 'public', fee: 0, dailyLimit: 1, listedAt: now }], reservations: {}, settled: {}, lends: { date: '', byHorse: {}, earned: 0 }, applied: {}, outbox: [], borrows: { date: '', count: 0 }, history: [] };
      s.training = { day: '', used: 0, open: { id: 't', horseId: ids[1]!, menuId: 'x', seed: 1, startedAt: now, expiresAt: now + 60_000, fatigueBefore: 0, bondLevel: 0, beats: [] }, horses: {}, total: 0 };
    });
    // tournaments: registration through the service writes the entry
    const backend: TournamentBackend = {
      list: async () => [], view: async () => ({ startsAtMs: NOW + DAY }), published: async () => null, me: async () => ({}),
      register: async () => ({ registered: true }), unregister: async () => ({ unregistered: true }), create: async () => ({}), cancel: async () => ({}),
    };
    const tours = new TournamentsService(() => m, backend, { ...tournamentPlayersFrom(() => w.invoker), tournamentEntry: async () => ({}) as never }, () => w.clock.now);
    await tours.register('p', 'cup_1', ids[2]!);
    const s = await st(w, 'p');
    expect(bulkReasons(s, ids[0]!, 'retire', w.clock.now)).toEqual(['on_loan']);
    expect(bulkReasons(s, ids[1]!, 'retire', w.clock.now)).toEqual(['in_training']);
    expect(bulkReasons(s, ids[2]!, 'retire', w.clock.now)).toEqual(['tournament_entry']);
    expect(bulkReasons(s, ids[1]!, 'retire', w.clock.now + 61_000)).toEqual([]); // the session expired
    expect(bulkReasons(s, ids[2]!, 'retire', NOW + DAY + ROSTER_LIMITS.tournamentGraceMs)).toEqual([]); // start + 24 h
    expect((await w.svc.roster('p')).horses.find((r) => r.horseId === ids[2])!.blocks).toEqual(['tournament_entry']);
    await tours.unregister('p', 'cup_1');
    expect(bulkReasons(await st(w, 'p'), ids[2]!, 'retire', w.clock.now)).toEqual([]);
    // a late note for a deleted (or never created) account never creates a state
    expect(await w.svc.rosterTournament('gone', 'cup_1', null, NOW)).toEqual({ ok: false });
    expect(w.repo.data.has('gone')).toBe(false);
    await tours.register('p', 'cup_2', ids[3]!);
    await w.svc.tournamentClose('p', 'cup_2', 3, null, 'Cup', ids[3]!);
    expect(bulkReasons(await st(w, 'p'), ids[3]!, 'retire', w.clock.now)).toEqual([]);
  });

  it('the partner is refused in bulk but the single retire keeps working (existing rule unchanged)', async () => {
    const w = world();
    const [a] = await horses(w, 'p', 1, { partnerFirst: true });
    const pv = await w.svc.rosterPreview('p', 'retire', [a!]);
    expect(pv.horses[0]!.reasons).toEqual(['partner']);
    expect((await w.svc.retire('p', a!)).status).toBe('retired');
  });
});

describe('厩舎の整理: KPI roster_sort (REQ-ORG-013)', () => {
  it('accepts the client event and maps it', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'roster_sort', at: 1, props: { sort: 'aptitude', filters: 2 } }] });
    expect(clientToKpi(b.events[0]!)).toEqual({ name: 'roster_sort', s1: 'aptitude', value: 2 });
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'roster_sort', at: 1, props: { sort: 'speed', filters: 2 } }] }).success).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- HTTP

function ctx(w: W): AppContext {
  return {
    master: m,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => w.invoker,
    clock: () => w.clock.now,
  } as unknown as AppContext;
}
async function call(c: AppContext, method: string, path: string, o: { user?: string; body?: unknown; lang?: string; key?: string } = {}) {
  const res = await handle(new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}), ...(o.lang ? { 'accept-language': o.lang } : {}), ...(o.key ? { 'idempotency-key': o.key } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  }), {}, c);
  return { status: res.status, body: (await res.json()) as any };
}

describe('HTTP API: /v1/roster (REQ-ORG-001..011)', () => {
  it('list with query, lock, favourite, preview, bulk; English notice; names never translated; refusals 409 with details', async () => {
    const w = world();
    const ids = await horses(w, 'a', 3);
    await w.svc.tx('a', null, (s) => { s.horses[0]!.name = 'ミドリノカゼ'; });
    const c = ctx(w);
    expect((await call(c, 'GET', '/v1/roster')).status).toBe(401);
    const list = await call(c, 'GET', '/v1/roster?sort=name&dir=asc&favoritesFirst=0', { user: 'a', lang: 'en' });
    expect(list.status).toBe(200);
    expect(list.body.notice).toBe('Retiring several horses at once gives back no coins or materials');
    expect(list.body.horses.map((r: RosterRow) => r.name)).toContain('ミドリノカゼ');
    expect((await call(c, 'GET', '/v1/roster?sort=speed', { user: 'a' })).status).toBe(400);
    expect((await call(c, 'GET', '/v1/roster?bogus=1', { user: 'a' })).status).toBe(400);
    expect((await call(c, 'PUT', `/v1/horses/${ids[0]}/lock`, { user: 'a', body: { locked: true } })).body).toEqual({ horseId: ids[0], locked: true });
    expect((await call(c, 'PUT', `/v1/horses/${ids[0]}/lock`, { user: 'a', body: { locked: 'yes' } })).status).toBe(400);
    expect((await call(c, 'PUT', `/v1/horses/${ids[1]}/favorite`, { user: 'a', body: { favorite: true } })).body).toEqual({ horseId: ids[1], favorite: true });
    expect((await call(c, 'POST', `/v1/horses/${ids[0]}/retire`, { user: 'a' })).body.error.code).toBe('HORSE_LOCKED');
    const pv = await call(c, 'POST', '/v1/roster/bulk/preview', { user: 'a', body: { action: 'retire', horseIds: ids } });
    expect(pv.body).toMatchObject({ canConfirm: false, refused: 1 });
    expect((await call(c, 'POST', '/v1/roster/bulk/preview', { user: 'a', body: { action: 'release', horseIds: ids } })).status).toBe(400);
    expect((await call(c, 'POST', '/v1/roster/bulk/preview', { user: 'a', body: { action: 'retire', horseIds: [] } })).status).toBe(400);
    expect((await call(c, 'POST', '/v1/roster/bulk/preview', { user: 'a', body: { action: 'retire', horseIds: Array.from({ length: 51 }, (_, i) => `h${i}`) } })).status).toBe(400);
    const refused = await call(c, 'POST', '/v1/roster/bulk', { user: 'a', key: 'b1', body: { action: 'retire', horseIds: ids, confirmToken: pv.body.confirmToken } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'ROSTER_BULK_REFUSED', details: { horses: [{ horseId: ids[0], name: 'ミドリノカゼ', reasons: ['locked'] }] } });
    const two = [ids[1]!, ids[2]!];
    const pv2 = await call(c, 'POST', '/v1/roster/bulk/preview', { user: 'a', body: { action: 'retire', horseIds: two } });
    expect((await call(c, 'POST', '/v1/roster/bulk', { user: 'a', body: { action: 'retire', horseIds: two, confirmToken: pv2.body.confirmToken } })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const ok = await call(c, 'POST', '/v1/roster/bulk', { user: 'a', key: 'b2', body: { action: 'retire', horseIds: two, confirmToken: pv2.body.confirmToken } });
    expect(ok.body).toMatchObject({ action: 'retire', count: 2 });
    const again = await call(c, 'POST', '/v1/roster/bulk', { user: 'a', key: 'b2', body: { action: 'retire', horseIds: two, confirmToken: pv2.body.confirmToken } });
    expect(again.body).toEqual(ok.body);
    const after = await call(c, 'GET', '/v1/roster?status=retired', { user: 'a' });
    expect(after.body.horses.map((r: RosterRow) => r.horseId).sort()).toEqual([...two].sort());
  });
});
