// REQ-PED-001..020: 血統図と系統 (pedigree viewer & bloodlines, contracts/protocol.md §71).
import { describe, expect, it } from 'vitest';
import { breed, breedingPreview, createHorseFromTemplate, inbreedingCount, pedigree, BREED } from '../src/domain/horses.js';
import {
  bloodlineProblems, bloodlinesOf, bloodlinesView, breedingPedigree, finishBreedingPedigree, finishPedigree, pedigreeMine, PedigreeService,
  type BloodlinesMaster, type PedNode,
} from '../src/domain/pedigree.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { HorseInstance, PlayerState } from '../src/domain/player.js';
import type { Master } from '../src/domain/master.js';
import { clientEventSchema, clientToKpi } from '../src/domain/kpi.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { endpointGroup, isExempt } from '../src/domain/maintenance.js';
import { helpArticle, helpProblems } from '../src/domain/help.js';
import { untranslated } from '../src/i18n/catalog.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 12, 3);
const tpl = (id: string) => m.templateById.get(id)!;
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return (e as AppError).code; }
  return 'NO_ERROR';
};
const retired = (s: PlayerState, id: string) => { const h = createHorseFromTemplate(s, tpl(id), NOW); h.status = 'retired'; return h; };
const walk = (n: PedNode | null, f: (n: PedNode) => void) => { if (!n) return; f(n); walk(n.sire, f); walk(n.dam, f); };
const nodes = (n: PedNode | null) => { const out: PedNode[] = []; walk(n, (x) => out.push(x)); return out; };

/** sire × dam → foal (male) and foal2 (female) siblings, then a brother × sister pairing (shared parents). */
function inbredFamily() {
  const s = freshPlayer('p1', NOW);
  const sire = retired(s, 't_akatsuki');
  const dam = retired(s, 't_kohaku');
  let a: HorseInstance | undefined, b: HorseInstance | undefined;
  for (let i = 0; i < 40 && (!a || !b); i++) {
    s.breeding = { date: null, count: 0 };
    const f = breed(m, s, sire.id, dam.id, seededRng(100 + i), NOW).foal;
    if (f.sex === 'male' && !a) a = f; else if (f.sex === 'female' && !b) b = f;
  }
  a!.status = 'retired'; b!.status = 'retired';
  return { s, sire, dam, brother: a!, sister: b! };
}

describe('lineage snapshot at birth (REQ-PED-001/002)', () => {
  it('a bred foal keeps its parents as they were (name, look, style, line, skill, stats) and no other player id', () => {
    const { s, sire, dam, brother } = inbredFamily();
    expect(brother.lineage).toMatchObject({ v: 1, sire: { name: sire.name, style: sire.style, line: sire.line, rarity: sire.rarity, templateId: 't_akatsuki', skillId: 'sk_kireaji', sireName: sire.sireName }, dam: { name: dam.name, line: dam.line } });
    expect(brother.lineage!.sire.appearance).toEqual(sire.appearance);
    expect(brother.lineage!.sire.stats.speed).toBeGreaterThan(0);
    // written after every roll: the same seed gives the same foal whatever the snapshot holds
    const s2 = freshPlayer('p1', NOW);
    const sire2 = retired(s2, 't_akatsuki'); const dam2 = retired(s2, 't_kohaku');
    const f1 = breed(m, s2, sire2.id, dam2.id, seededRng(100), NOW).foal;
    const s3 = freshPlayer('p1', NOW);
    const sire3 = retired(s3, 't_akatsuki'); const dam3 = retired(s3, 't_kohaku');
    sire3.awakening = 2; // changes the snapshot's stats, and the baseline (expected), but not the draw order
    const f2 = breed(m, s3, sire3.id, dam3.id, seededRng(100), NOW).foal;
    expect([f1.sex, f1.style, f1.appearance]).toEqual([f2.sex, f2.style, f2.appearance]);
    void s;
  });

  it('template horses have no snapshot; their fictional parents are names only → 記録なし, a founder is marked', () => {
    const s = freshPlayer('p1', NOW);
    const h = createHorseFromTemplate(s, tpl('t_akatsuki'), NOW);
    expect(h.lineage).toBeUndefined();
    const d = pedigreeMine(m, s, h.id, 'ja', NOW);
    expect(d.tree.sire).toMatchObject({ key: 'name:アカツキオー', name: 'アカツキオー', rec: null, recordText: '記録なし', founder: true, gen: 1 });
    expect(d.tree.dam).toMatchObject({ rec: null, recordText: '記録なし', founder: false });
    expect(d.tree.rec).toMatchObject({ source: 'live', style: 'sashi', line: 'akatsuki', lineName: 'アカツキ系', thumbKey: 'collection/portrait/t_akatsuki', skill: { id: 'sk_kireaji' }, status: 'active', bestText: '出走なし' });
  });
});

describe('the tree (REQ-PED-003/004)', () => {
  it('keeps the old fields and the 5-generation walk; the keys are the ones the inbreeding rule uses', () => {
    const { s, brother, sister } = inbredFamily();
    s.breeding = { date: null, count: 0 };
    const child = breed(m, s, brother.id, sister.id, seededRng(9), NOW).foal;
    const old = pedigree(s, child.id);
    const d = pedigreeMine(m, s, child.id, 'ja', NOW);
    const strip = (n: PedNode | null): unknown => (n ? { key: n.key, name: n.name, horseId: n.horseId, sire: strip(n.sire), dam: strip(n.dam) } : null);
    expect(strip(d.tree)).toEqual(JSON.parse(JSON.stringify(old)));
    // brother × sister: the grandparents are shared (2 ancestors), exactly what breeding counted
    expect(d.sharedKeys.length).toBe(inbreedingCount(s, brother, sister));
    expect(d.sharedKeys).toContain(brother.sireId);
    const shared = nodes(d.tree).filter((n) => n.shared && n.gen <= 3);
    expect(new Set(shared.map((n) => n.key))).toEqual(new Set(d.sharedKeys));
    const body = finishPedigree(m, d, {}, 'ja');
    expect(body).toMatchObject({ v: 2, relation: 'self', generations: 5, line: 'akatsuki', lineName: 'アカツキ系', inbreeding: { count: d.sharedKeys.length, penaltyPerAncestor: BREED.inbreedingPenalty } });
    expect(body.rev).toMatch(/^[0-9a-f]{16}$/);
    // the same state gives the same rev (cache-friendly)
    expect(finishPedigree(m, pedigreeMine(m, s, child.id, 'ja', NOW), {}, 'ja').rev).toBe(body.rev);
  });

  it('own records: stats for my own horses only, the career best from §34, retired ancestors still show', () => {
    const { s, brother } = inbredFamily();
    s.hall = { careers: { [brother.sireId!]: { horseId: brother.sireId!, races: 12, wins: 4, places: 7, byMode: {}, bestTa: {}, tournaments: [], tournamentWins: 1, biggestWin: null, rivalWins: 0, firstRaceAt: 1, lastRaceAt: 2 } }, ceremonies: {}, entries: [], visibility: 'friends_team', rewarded: false } as never;
    const d = pedigreeMine(m, s, brother.id, 'ja', NOW);
    expect(d.tree.sire!.rec).toMatchObject({ status: 'retired', best: { races: 12, wins: 4, tournamentWins: 1 }, bestText: '12戦4勝・大会優勝1回' });
    expect(d.tree.sire!.rec!.stats).toBeDefined();
  });
});

describe('the breeding pair (REQ-PED-009/010)', () => {
  it('shared ancestors equal inbreedingCount; hints come straight from previewFor (no invented numbers)', () => {
    const { s, brother, sister } = inbredFamily();
    const d = breedingPedigree(m, s, brother.id, sister.id, 'ja', NOW);
    expect(d.sharedKeys.length).toBe(inbreedingCount(s, brother, sister));
    expect(d.inbreeding).toEqual({ count: inbreedingCount(s, brother, sister), penaltyPerAncestor: BREED.inbreedingPenalty, statPenalty: inbreedingCount(s, brother, sister) * BREED.inbreedingPenalty });
    const pv = breedingPreview(m, s, brother.id, sister.id);
    const styleHints = d.hints.filter((h) => h.kind === 'style');
    for (const h of styleHints) expect(Object.values(pv.styles).map((p) => p * 10)).toContain(h.permille);
    for (const h of d.hints.filter((x) => x.kind === 'skill')) expect(pv.skill.candidates.map((c) => c.permille)).toContain(h.permille);
    expect(d.hints.find((h) => h.kind === 'inbreeding')!.value).toBe(d.inbreeding.count);
    expect(d.hints[0]).toMatchObject({ kind: 'line', hintText: '仔の系統は父と同じ「アカツキ系」' });
    expect(d.nick).toEqual({ on: pv.nick, bonus: pv.nick ? m.nicks.bonus : 0 });
    const body = finishBreedingPedigree(d, {});
    expect('owners' in body).toBe(false);
    expect(body.shared.length).toBe(body.sharedKeys.length);
  });

  it('a nick pair shows the nick bonus; the same checks as the preview refuse a bad pair', async () => {
    const s = freshPlayer('p1', NOW);
    const sire = retired(s, 't_ginga'); // hoshi
    const dam = retired(s, 't_kohaku'); // hayate (hoshi × hayate is a nick)
    const d = breedingPedigree(m, s, sire.id, dam.id, 'en', NOW);
    expect(d.nick).toEqual({ on: true, bonus: m.nicks.bonus });
    expect(d.hints.find((h) => h.kind === 'nick')!.hintText).toBe(`Nick (a good line match): base stats +${m.nicks.bonus}`);
    for (const h of d.hints) expect(h.hintText).not.toMatch(/odds|bet|お得|倍/i);
    expect(await code(() => breedingPedigree(m, s, dam.id, sire.id, 'ja', NOW))).toBe('BREEDING_INVALID_PAIR');
    const young = createHorseFromTemplate(s, tpl('t_natsu'), NOW);
    expect(await code(() => breedingPedigree(m, s, young.id, dam.id, 'ja', NOW))).toBe('HORSE_NOT_RETIRED');
    expect(await code(() => breedingPedigree(m, s, 'h999', dam.id, 'ja', NOW))).toBe('HORSE_NOT_FOUND');
  });
});

describe('bloodlines (REQ-PED-011..013)', () => {
  it('the shipped master covers every template and nick line; bad entries are refused', () => {
    expect(bloodlineProblems(m)).toEqual([]);
    const bm = bloodlinesOf(m);
    const bad = (patch: (x: BloodlinesMaster) => void) => { const c = structuredClone(bm); patch(c); return bloodlineProblems({ ...m, bloodlines: c } as Master).join(); };
    expect(bad((x) => { x.lines = x.lines.filter((l) => l.id !== 'hoshi'); })).toMatch(/hoshi has no entry/);
    expect(bad((x) => { x.lines[0]!.note.ja = '今だけお得な系統'; })).toMatch(/今だけ/);
    expect(bad((x) => { x.lines[0]!.en = 'アカツキ line'; })).toMatch(/Japanese/);
    expect(bad((x) => { x.lines[0]!.note.en = 'Great odds'; })).toMatch(/betting/);
    expect(bad((x) => { x.lines.push({ ...x.lines[0]! }); })).toMatch(/duplicate/);
  });

  it('per-line counts, nick partners from nicks.json, empty lines listed, no reward or completion state', () => {
    const { s } = inbredFamily();
    const v = bloodlinesView(m, s, 'en');
    const ak = v.lines.find((l) => l.id === 'akatsuki')!;
    expect(ak).toMatchObject({ lineName: 'Akatsuki line', founderName: 'Akatsuki Oh', count: s.horses.filter((h) => h.line === 'akatsuki').length });
    expect(ak.nickWith).toEqual(expect.arrayContaining([{ id: 'minamo', lineName: 'Minamo line', role: 'dam', bonus: m.nicks.bonus }, { id: 'hayate', lineName: 'Hayate line', role: 'sire', bonus: m.nicks.bonus }]));
    expect(v.lines.find((l) => l.id === 'kawarabi')!.count).toBe(0);
    expect(v.lines.map((l) => l.id)).toEqual(bloodlinesOf(m).lines.map((l) => l.id));
    expect(JSON.stringify(v)).not.toMatch(/reward"|complete|achiev|freeCoins|items/i);
    expect(v.notice).toBe('系統の数で報酬はありません。');
  });
});

// ------------------------------------------------------------------------------------------------ services

function world() {
  const dir = new MemoryDirectory();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(71), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() }, onProfile: (p) => dir.putProfile(p) });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const service = new PedigreeService({
    mine: (u, h, l) => svc.pedigreeMine(u, h, l),
    publicOf: (o, h, l, r) => svc.pedigreePublic(o, h, l, r),
    pair: (u, a, b, l) => svc.pedigreePair(u, a, b, l),
    viewer: (u) => svc.showcaseViewer(u),
    blocks: async (u) => (await svc.showcaseViewer(u)).blocked,
    profiles: (ids) => dir.profiles(ids),
  }, () => m);
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: { enqueue: async () => ({}), cancel: async () => ({}), status: async () => ({ state: 'none' }), friendCreate: async () => ({}), friendJoin: async () => ({}), friendStart: async () => ({}), tutorial: async () => ({}), friendMember: async () => false },
    friends: makeFriendsService(() => invoker, dir),
    leaderboard: { board: async (season, board) => ({ season, board }), myRank: async (p, season) => ({ p, season }) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => NOW,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async () => ({}) },
    paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
  };
  const edit = <T>(id: string, f: (s: PlayerState) => T) => svc.tx(id, null, (s) => f(s));
  return { svc, dir, service, c, edit };
}
const call = async (c: AppContext, user: string, path: string, headers: Record<string, string> = {}) => {
  const r = await handle(new Request(`https://x${path}`, { headers: { 'x-test-user': user, ...headers } }), {}, c);
  return { status: r.status, etag: r.headers.get('etag'), cache: r.headers.get('cache-control'), body: r.status === 304 ? null : await r.json() as Record<string, unknown> };
};

/** o lent a stallion to b (the foal's studSire), b's foal is featured on b's trainer card. */
async function studFamily(w: ReturnType<typeof world>, opts: { friends?: boolean } = {}) {
  for (const id of ['o', 'b', 'v']) await w.svc.bootstrap(id);
  const stallion = await w.edit('o', (s) => retired(s, 't_ginga'));
  // the foal as studApply builds it (REQ-BREED-014), with its birth snapshot (REQ-PED-001)
  const foal = await w.edit('b', (s) => {
    const mare = retired(s, 't_kohaku');
    s.counters.horseSeq += 1;
    const f: HorseInstance = {
      id: `h${s.counters.horseSeq}`, templateId: null, name: 'ホシカゲ', rarity: 'SR', sex: 'male', style: 'senko', distMinM: 1600, distMaxM: 2200, surface: 'turf',
      line: 'hoshi', base: { speed: 700, stamina: 700, burst: 700, guts: 700, temper: 600 }, awakening: 0, bornAt: NOW, status: 'active',
      sireId: null, damId: mare.id, sireName: stallion.name, damName: mare.name, named: true,
      studSire: { ownerId: 'o', horseId: stallion.id, sireName: stallion.sireName, damName: stallion.damName },
      lineage: {
        v: 1,
        sire: { name: stallion.name, templateId: 't_ginga', rarity: stallion.rarity, sex: 'male', style: stallion.style, surface: stallion.surface, line: stallion.line, appearance: stallion.appearance!, stats: stallion.base, sireName: stallion.sireName, damName: stallion.damName, skillId: 'sk_oudou' },
        dam: { name: mare.name, templateId: 't_kohaku', rarity: mare.rarity, sex: 'female', style: mare.style, surface: mare.surface, line: mare.line, appearance: mare.appearance!, stats: mare.base, sireName: mare.sireName, damName: mare.damName },
      },
    };
    s.horses.push(f);
    if (opts.friends) { s.friends.ids.push('o'); }
    return f;
  });
  if (opts.friends) await w.edit('o', (s) => { s.friends.ids.push('b'); });
  return { stallion, foal };
}
const feature = (w: ReturnType<typeof world>, id: string, horseId: string) => w.edit(id, (s) => { s.showcase = { horseId, pins: [], taTrackIds: [], phraseId: null, backgroundId: 'dawn', updatedAt: NOW }; });

describe('borrowed stallions and other players (REQ-PED-005..007)', () => {
  it('a stranger\'s stallion shows 「他のトレーナーの馬」; a friend\'s its owner name; never the owner id', async () => {
    const w = world();
    const { foal } = await studFamily(w);
    const v = await w.service.horse('b', foal.id, null, 'ja');
    expect(v.sire).toMatchObject({ key: 'stud:1', lent: { ownerName: null, label: '他のトレーナーの馬' }, rec: { source: 'snapshot', skill: { id: 'sk_oudou' }, best: null } });
    expect(v.sire!.sire).toMatchObject({ name: 'ホシノオウ', recordText: '記録なし', founder: true });
    expect(JSON.stringify(v)).not.toMatch(/"o"|stud:o:|_owner/);
    const w2 = world();
    const r2 = await studFamily(w2, { friends: true });
    const v2 = await w2.service.horse('b', r2.foal.id, null, 'ja');
    expect(v2.sire!.lent).toEqual({ ownerName: (await w2.dir.profiles(['o']))[0]!.displayName, label: 'フレンドの種牡馬' });
    // blocked friend → no name
    await w2.svc.blockSet('b', 'o', true, 'blocks');
    const v3 = await w2.service.horse('b', r2.foal.id, null, 'ja');
    expect(v3.sire!.lent!.ownerName).toBeNull();
  });

  it('another player\'s horse: only while shown publicly; blocks either way, a banned profile → 404', async () => {
    const w = world();
    const { foal } = await studFamily(w);
    expect(await code(w.service.horse('v', foal.id, 'b', 'ja'))).toBe('NOT_FOUND');
    await feature(w, 'b', foal.id);
    const v = await w.service.horse('v', foal.id, 'b', 'ja');
    expect(v).toMatchObject({ relation: 'other', generations: 3, horseId: foal.id });
    expect(v.rec!.stats).toBeUndefined(); // no stats for others
    expect(v.dam!.horseId).toBeNull(); // only the shown horse's id
    expect(nodes(v as PedNode).every((n) => n.gen <= 3)).toBe(true);
    // the owner viewing it as "another player" path is just their own tree
    expect((await w.service.horse('b', foal.id, 'b', 'ja')).relation).toBe('self');
    await w.svc.blockSet('b', 'v', true, 'blocks');
    expect(await code(w.service.horse('v', foal.id, 'b', 'ja'))).toBe('NOT_FOUND');
    await w.svc.blockSet('b', 'v', false, 'blocks');
    await w.svc.blockSet('v', 'b', true, 'blocks');
    expect(await code(w.service.horse('v', foal.id, 'b', 'ja'))).toBe('NOT_FOUND');
    await w.svc.blockSet('v', 'b', false, 'blocks');
    expect((await w.service.horse('v', foal.id, 'b', 'ja')).relation).toBe('other');
    await w.edit('b', (s) => { s.moderation = { status: 'banned', until: null, reason: 'x', at: NOW }; });
    expect(await code(w.service.horse('v', foal.id, 'b', 'ja'))).toBe('NOT_FOUND');
    expect(await code(w.service.horse('v', foal.id, 'nobody', 'ja'))).toBe('NOT_FOUND');
  });

  it('under-13 owners: others see no owner-typed names; master names stay; the owner sees everything', async () => {
    const w = world();
    const { foal } = await studFamily(w);
    await feature(w, 'b', foal.id);
    await w.edit('b', (s) => { s.age = { birthYear: 2016, birthMonth: 1, guardianConsent: true, setAt: NOW }; });
    const v = await w.service.horse('v', foal.id, 'b', 'ja');
    expect(v).toMatchObject({ young: true, name: '名前は非公開', nameHidden: true });
    expect(v.dam!.name).toBe('コハクノヒカリ'); // template name
    expect(v.sire!.sire!.name).toBe('ホシノオウ');
    expect((await w.service.horse('b', foal.id, null, 'ja')).name).toBe('ホシカゲ');
  });
});

describe('HTTP, gate, KPI, help (REQ-PED-008/014/016/019)', () => {
  it('GET pedigree carries an ETag (304 on match), English has nothing untranslated, pair and bloodlines answer', async () => {
    const w = world();
    const { foal } = await studFamily(w);
    const r = await call(w.c, 'b', `/v1/horses/${foal.id}/pedigree?lang=en`);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, no-cache');
    expect(r.etag).toMatch(/^"[0-9a-f]{16}-en"$/);
    expect(untranslated(r.body, new Set(['key', 'name', 'ownerName', 'hintText']))).toEqual([]);
    expect((r.body!.sire as { lent: { label: string } }).lent.label).toBe("Another trainer's horse");
    expect((await call(w.c, 'b', `/v1/horses/${foal.id}/pedigree?lang=en`, { 'if-none-match': r.etag! })).status).toBe(304);
    expect((await call(w.c, 'b', `/v1/horses/${foal.id}/pedigree?lang=ja`, { 'if-none-match': r.etag! })).status).toBe(200);
    expect((await call(w.c, 'v', `/v1/horses/${foal.id}/pedigree?playerId=b`)).status).toBe(404);
    const bl = await call(w.c, 'b', '/v1/bloodlines?lang=en');
    expect(bl.status).toBe(200);
    expect(untranslated(bl.body, new Set(['key', 'name']))).toEqual([]);
    const ids = await w.edit('b', (s) => { const a = retired(s, 't_ginga'); const b = retired(s, 't_minamo'); return [a.id, b.id]; });
    const pr = await call(w.c, 'b', `/v1/breeding/pedigree?sireId=${ids[0]}&damId=${ids[1]}&lang=en`);
    expect(pr.status).toBe(200);
    expect(untranslated(pr.body, new Set(['key', 'name', 'ownerName', 'hintText']))).toEqual([]);
    expect((await call(w.c, 'b', `/v1/breeding/pedigree?sireId=${ids[0]}`)).status).toBe(400);
  });

  it('routes are in the core gate group (never exempt); KPI events are strict, optional and id-free', () => {
    for (const p of ['/v1/horses/h1/pedigree', '/v1/breeding/pedigree', '/v1/bloodlines']) {
      expect(endpointGroup(p)).toBe('core');
      expect(isExempt('GET', p)).toBe(false);
    }
    const ok = clientEventSchema.parse({ name: 'pedigree_view', at: NOW, props: { source: 'breeding', relation: 'self', shared: 2 } });
    expect(clientToKpi(ok)).toEqual({ name: 'pedigree_view', s1: 'breeding', s2: 'self', count: 2 });
    expect(clientToKpi(clientEventSchema.parse({ name: 'bloodline_view', at: NOW, props: { source: 'pedigree', lines: 7 } }))).toEqual({ name: 'bloodline_view', s1: 'pedigree', value: 7 });
    expect(() => clientEventSchema.parse({ name: 'pedigree_view', at: NOW, props: { source: 'horse', relation: 'other', shared: 0, playerId: 'b' } })).toThrow();
    expect(() => clientEventSchema.parse({ name: 'pedigree_view', at: NOW, props: { source: 'horse', relation: 'other', shared: 15 } })).toThrow();
    expect(kpiClassOf('pedigree_view')).toBe('optional');
    expect(kpiClassOf('bloodline_view')).toBe('optional');
  });

  it('the help article fills its tokens from the breeding rules', () => {
    expect(helpProblems(m)).toEqual([]);
    const a = helpArticle(m, 'pedigree', 'ja') as { body: string };
    expect(a.body).toContain(`${BREED.inbreedingPenalty}下がります`);
    expect(a.body).toContain(`${m.nicks.bonus}上がります`);
  });
});
