// REQ-SHOW-001..018: プロフィールのショーケース（トレーナーカード、contracts/protocol.md §62).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { PlayerState } from '../src/domain/player.js';
import type { PublicProfile } from '../src/domain/stats.js';
import type { Master } from '../src/domain/master.js';
import { clientEventSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { endpointGroup, isExempt } from '../src/domain/maintenance.js';
import { classifyKey } from '../src/domain/dataExport.js';
import { buildAssetManifest } from '../src/domain/assetManifest.js';
import { untranslated } from '../src/i18n/catalog.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import {
  forgetShowcase, neutralShowcase, renderShowcase, showcaseCopy, showcaseOf, showcaseProblems, ShowcaseService,
  SHOWCASE_NEUTRAL_NAME, type ShowcaseCardView, type ShowcaseInput, type ShowcaseMaster,
} from '../src/domain/showcase.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 11, 3);
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function world() {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const dir = new MemoryDirectory();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(62), clock: () => now, verifiers: { fake: new FakeStoreVerifier() },
    onProfile: (p) => dir.putProfile(p), onKpi: (_id, recs) => { kpi.push(...recs); },
  });
  // a change inside a transaction (like a support action or a race result), so the profile push sees it
  const edit = async (id: string, f: (s: PlayerState) => void) => { await svc.tx(id, null, (s) => { f(s); }); };
  const service = new ShowcaseService({
    profiles: (ids) => dir.profiles(ids),
    viewer: (u) => svc.showcaseViewer(u),
    blocks: async (u) => (await svc.showcaseViewer(u)).blocked,
    mine: (u, l) => svc.showcaseMine(u, l),
  }, () => m, () => now);
  return { svc, repo, dir, kpi, edit, service, advance: (ms: number) => { now += ms; }, now: () => now };
}

/** A player with a partner horse, a title, a wins achievement tier, a TA record, a finished cup with a trophy and a hall entry. */
async function decorated(w: ReturnType<typeof world>, id: string) {
  await w.svc.bootstrap(id);
  await w.svc.grantPartner(id, 'ミドリノカゼ', `c:p:${id}`);
  const title = m.titles[0]!.id;
  const track = m.tracks[0]!.id;
  let horseId = '';
  await w.edit(id, (s) => {
    horseId = s.horses[0]!.id;
    s.titles.push(title);
    s.stats.wins = 3; s.stats.races = 12; // REQ-ACH: syncCollection unlocks wins tier 1 → the turf_stretch background
    s.timeAttack = { sessions: [], daily: { date: '', count: 0 }, seasonBest: {}, allTimeBest: { [track]: { timeMs: 95_400, finishTick: 1900, finishFrac: 0, sessionId: 's1', horseId, horseName: 'ミドリノカゼ', at: NOW } }, milestones: [] };
    s.cups = { active: [], invites: [], history: [{ cupId: 'cup_aaaaaaaaaaaaaaaa', cupName: '春の小さな杯', format: 'single', rank: 1, points: 10, entrants: 4, at: NOW, status: 'finished', partial: false, cancelReason: null, trophy: 'gold' }], trophies: { gold: 1, silver: 0, bronze: 0 }, codeAttempts: { hour: 0, count: 0 } };
    s.tournaments = { t_autumn: { name: '秋の大会', rank: 2, at: NOW, reward: null } };
  });
  return { horseId, title, track };
}

const fullInput = (d: { horseId: string; title: string; track: string }): ShowcaseInput => ({
  horseId: d.horseId,
  pins: [{ kind: 'title', id: d.title }, { kind: 'cup_trophy', id: 'cup_aaaaaaaaaaaaaaaa' }, { kind: 'achievement', id: 'wins' }],
  taTrackIds: [d.track], phraseId: 'race_anytime', backgroundId: 'turf_stretch',
});

describe('catalog (REQ-SHOW-002)', () => {
  it('the shipped master passes; phrases are fixed JA+EN with no betting / shop words', () => {
    expect(showcaseProblems(m)).toEqual([]);
    for (const p of showcaseOf(m).phrases) { expect(bettingWordsIn(p.ja)).toEqual([]); expect(p.en).not.toMatch(/[ぁ-ん]/); }
  });
  it('refuses shop words, slots, sold backgrounds, a 4th pin and a missing default', () => {
    const base = showcaseOf(m);
    const bad = (patch: Partial<ShowcaseMaster>) => showcaseProblems({ ...m, showcase: { ...base, ...patch } } as Master);
    expect(bad({ phrases: [{ id: 'x', ja: '今だけ走ろう', en: 'Race now' }] }).join()).toMatch(/今だけ/);
    expect(bad({ phrases: [{ id: 'x', ja: '{horse}と走る', en: 'With {horse}' }] }).join()).toMatch(/no slots/);
    expect(bad({ backgrounds: [...base.backgrounds, { id: 'paid', ja: '有償', en: 'Paid', unlock: { kind: 'cosmetic', itemId: 'x' } as never }] }).join()).toMatch(/never sold/);
    expect(bad({ config: { ...base.config, pinsMax: 4 } }).join()).toMatch(/pinsMax/);
    expect(bad({ backgrounds: base.backgrounds.filter((b) => b.unlock.kind !== 'default') }).join()).toMatch(/exactly one default/);
    expect(bad({ backgrounds: [...base.backgrounds, { id: 'ghost', ja: '幽霊', en: 'Ghost', unlock: { kind: 'achievement', achievementId: 'nope', tier: 1 } }] }).join()).toMatch(/unknown achievement/);
  });
  it('every background has an asset key in the manifest (showcase/bg/<id>)', () => {
    const keys = new Set(buildAssetManifest(m, { phrases: {} } as never).keys);
    for (const b of showcaseOf(m).backgrounds) expect(keys.has(`showcase/bg/${b.id}`), b.id).toBe(true);
  });
});

describe('saving (REQ-SHOW-003/004)', () => {
  it('stores a fully earned selection and sends showcase_save once (the same selection again is a no-op)', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    const r = await w.svc.showcaseSave('a', fullInput(d));
    expect(r.saved).toBe(true);
    expect(r.preview.pins.map((p) => p.kind)).toEqual(['title', 'cup_trophy', 'achievement']);
    expect(r.preview.horse?.horseName).toBe('ミドリノカゼ');
    expect(r.preview.timeAttack[0]).toMatchObject({ trackId: d.track, time: '1:35.4', horseName: 'ミドリノカゼ' });
    expect(r.preview.background.id).toBe('turf_stretch');
    expect(w.kpi.filter((k) => k.name === 'showcase_save')).toHaveLength(1);
    await w.svc.showcaseSave('a', fullInput(d));
    expect(w.kpi.filter((k) => k.name === 'showcase_save')).toHaveLength(1);
    expect(w.kpi.find((k) => k.name === 'showcase_save')).toMatchObject({ s1: 'turf_stretch', s2: 'horse', s3: 'phrase', count: 3, value: 1 });
  });
  it('refuses anything not owned / earned, too many and duplicates', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    const base = fullInput(d);
    expect(await code(w.svc.showcaseSave('a', { ...base, horseId: 'h_nope' }))).toBe('HORSE_NOT_FOUND');
    const have = (await w.svc.state('a')).titles;
    const unearned = m.titles.find((t) => !have.includes(t.id))!.id;
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [{ kind: 'title', id: unearned }] }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [{ kind: 'hall', id: d.horseId }] }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [{ kind: 'tournament', id: 't_nope' }] }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [{ kind: 'goal_ribbon', id: d.horseId }] }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [base.pins[0]!, base.pins[0]!] }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [...base.pins, { kind: 'tournament', id: 't_autumn' }] }))).toBe('BAD_REQUEST');
    expect(await code(w.svc.showcaseSave('a', { ...base, taTrackIds: [m.tracks[1]!.id] }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, taTrackIds: ['nowhere'] }))).toBe('NOT_FOUND');
    expect(await code(w.svc.showcaseSave('a', { ...base, phraseId: 'free_text' }))).toBe('NOT_FOUND');
    expect(await code(w.svc.showcaseSave('a', { ...base, backgroundId: 'golden_gate' }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.showcaseSave('a', { ...base, backgroundId: 'nope' }))).toBe('NOT_FOUND');
    // the tournament podium (2nd) is pinnable; a refused save stored nothing
    expect((await w.svc.showcaseMine('a')).saved).toBe(false);
    expect(await code(w.svc.showcaseSave('a', { ...base, pins: [{ kind: 'tournament', id: 't_autumn' }] }))).toBe('ok');
    await w.svc.retire('a', d.horseId);
    expect(await code(w.svc.showcaseSave('a', base))).toBe('HORSE_NOT_ACTIVE');
  });
  it('a banned account or a scheduled deletion cannot edit', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.setModeration('a', 'banned', null, 'test');
    expect(await code(w.svc.showcaseSave('a', fullInput(d)))).toBe('BANNED');
  });
  it('the editor lists only what the player has: active horses, earned pins, courses with a record, unlocks', async () => {
    const w = world();
    await decorated(w, 'a');
    const v = await w.svc.showcaseMine('a');
    expect(v.horses).toHaveLength(1);
    expect([...new Set(v.pins.map((p) => p.kind))].sort()).toEqual(['achievement', 'cup_trophy', 'title', 'tournament']);
    const st = await w.svc.state('a');
    expect(v.pins.filter((p) => p.kind === 'title').map((p) => p.id).sort()).toEqual([...st.titles].sort());
    expect(v.courses).toHaveLength(1);
    expect(v.backgrounds.filter((b) => b.unlocked).map((b) => b.id)).toEqual(['dawn', 'turf_stretch']);
    expect(v.limits).toEqual({ pinsMax: 3, taMax: 2 });
    expect(v.preview.state).toBe('ok');
    expect(v.preview.reportable).toBe(false);
  });
});

describe('the public copy re-checks on every push (REQ-SHOW-005)', () => {
  it('a retired favourite and a revoked title quietly drop off; the friend list does not carry the card', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    const copy = (await w.dir.profiles(['a']))[0]!.showcase!;
    expect(copy.horse?.horseId).toBe(d.horseId);
    expect(copy.pins).toHaveLength(3);
    expect(JSON.stringify(copy)).not.toMatch(/"playerId"/); // the copy names nobody (the profile carries the owner's id)
    await w.svc.retire('a', d.horseId);
    await w.edit('a', (s) => { s.titles = s.titles.filter((t) => t !== d.title); });
    const after = (await w.dir.profiles(['a']))[0]!.showcase!;
    expect(after.horse).toBeNull();
    expect(after.pins.map((p) => p.kind)).toEqual(['cup_trophy', 'achievement']);
    // the selection itself is kept (an unretired / regained item would come back); nothing errors
    expect((await w.svc.state('a')).showcase?.pins).toHaveLength(3);
    const fs = makeFriendsService(() => ({ invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] }), w.dir);
    await w.svc.bootstrap('b');
    await fs.requestTo('b', 'a');
    await fs.accept('a', 'b');
    const list = await fs.list('b');
    expect(list.friends[0]).not.toHaveProperty('showcase');
  });
  it('a horse lent out as a stud (貸し出し中) drops off and cannot be chosen; it comes back when the listing ends', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    const listing = { horseId: d.horseId, visibility: 'friends' as const, fee: 10, dailyLimit: 1, listedAt: NOW };
    await w.edit('a', (s) => { s.stud = { listings: [listing], reservations: {}, settled: {}, lends: { date: '', byHorse: {}, earned: 0 }, applied: {}, outbox: [], borrows: { date: '', count: 0 }, history: [] }; });
    expect((await w.dir.profiles(['a']))[0]!.showcase!.horse).toBeNull();
    expect(await code(w.svc.showcaseSave('a', { ...fullInput(d), phraseId: 'hello' }))).toBe('NOT_ELIGIBLE');
    expect((await w.svc.showcaseMine('a')).horses).toEqual([]);
    await w.edit('a', (s) => { s.stud!.listings = []; });
    expect((await w.dir.profiles(['a']))[0]!.showcase!.horse?.horseId).toBe(d.horseId);
  });
  it('a pruned cup result drops off; a banned account and a running deletion publish no card', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    await w.edit('a', (s) => { s.cups!.history = []; });
    expect((await w.dir.profiles(['a']))[0]!.showcase!.pins.map((p) => p.kind)).toEqual(['title', 'achievement']);
    await w.svc.setModeration('a', 'banned', null, 'test');
    const p = (await w.dir.profiles(['a']))[0]!;
    expect(p.banned).toBe(true);
    expect(p.showcase).toBeUndefined();
  });
  it('under-13 owners publish no player-typed names (horse, cup); the fixed phrase still shows', async () => {
    const w = world();
    const d = await decorated(w, 'kid');
    await w.edit('kid', (s) => { s.age = { birthYear: 2016, birthMonth: 1, guardianConsent: true, setAt: NOW }; });
    await w.svc.showcaseSave('kid', fullInput(d));
    const copy = (await w.dir.profiles(['kid']))[0]!.showcase!;
    expect(copy.young).toBe(true);
    expect(copy.horse?.name).toBeNull();
    expect(copy.ta[0]!.horseName).toBeNull();
    expect(copy.pins.find((p) => p.kind === 'cup_trophy')?.name).toBeNull();
    expect(JSON.stringify(copy)).not.toMatch(/ミドリノカゼ|春の小さな杯/);
    expect(copy.phraseId).toBe('race_anytime');
    await w.svc.bootstrap('v');
    const card = await w.service.card('v', 'kid', 'ja');
    expect(card.horse?.horseName).toBeNull();
    expect(card.reportableHorseId).toBeNull();
    expect(card.pins.find((p) => p.kind === 'cup_trophy')).not.toHaveProperty('cupName');
  });
});

describe('opening a card (REQ-SHOW-007..011)', () => {
  it('another player sees the card in their own language; relation friend / other', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    await w.svc.bootstrap('v');
    const ja = await w.service.card('v', 'a', 'ja');
    expect(ja).toMatchObject({ state: 'ok', displayName: (await w.svc.state('a')).profile.displayName, relation: 'other', reportable: true, reportableHorseId: d.horseId });
    expect(ja.phrase).toEqual({ id: 'race_anytime', phraseText: 'いつでもレースしよう！' });
    const en = await w.service.card('v', 'a', 'en');
    expect(en.phrase?.phraseText).toBe('Race me any time!');
    expect(en.background.backgroundName).toBe('Turf stretch');
    expect(en.horse?.horseName).toBe('ミドリノカゼ'); // player-typed: never translated
  });
  it('a block either way, a deleted account and a banned one give the same neutral card', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    await w.svc.bootstrap('v');
    const neutral = (c: ShowcaseCardView) => { expect(c).toMatchObject({ state: 'neutral', displayName: 'プレイヤー', pins: [], horse: null, phrase: null, reportable: false, stats: null }); };
    await w.svc.blockSet('v', 'a', true, 'blocks');
    neutral(await w.service.card('v', 'a', 'ja'));
    await w.svc.blockSet('v', 'a', false, 'blocks');
    expect((await w.service.card('v', 'a', 'ja')).state).toBe('ok');
    await w.svc.blockSet('a', 'v', true, 'blocks');
    neutral(await w.service.card('v', 'a', 'ja'));
    await w.svc.blockSet('a', 'v', false, 'blocks');
    neutral(await w.service.card('v', 'gone_forever', 'ja')); // no profile (deleted / unknown)
    expect((await w.service.card('v', 'gone_forever', 'en')).displayName).toBe(SHOWCASE_NEUTRAL_NAME.en);
    await w.svc.setModeration('a', 'banned', null, 'test');
    neutral(await w.service.card('v', 'a', 'ja'));
  });
  it('a copy written last season shows no season class once the month rolled over (the owner has not played since)', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.edit('a', (s) => { s.season.races = 3; });
    await w.svc.showcaseSave('a', fullInput(d));
    await w.svc.bootstrap('v');
    expect((await w.service.card('v', 'a', 'ja')).seasonClass?.classId).toBe('C');
    w.advance(40 * 86_400_000);
    expect((await w.service.card('v', 'a', 'ja')).seasonClass).toBeNull();
    expect((await w.svc.showcaseMine('a')).preview.seasonClass).toBeNull(); // own state before its rollover transaction
  });
  it('re-checks against the current master on read: a removed background / title / course falls back or drops off', async () => {
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    const p = (await w.dir.profiles(['a']))[0]! as PublicProfile;
    const sm = showcaseOf(m);
    const m2 = { ...m, titles: m.titles.filter((t) => t.id !== d.title), tracks: m.tracks.filter((t) => t.id !== d.track), showcase: { ...sm, backgrounds: sm.backgrounds.filter((b) => b.id !== 'turf_stretch'), phrases: sm.phrases.filter((x) => x.id !== 'race_anytime') } } as Master;
    const c = renderShowcase(m2, p, p.showcase!, 'ja', 'other');
    expect(c.background.id).toBe('dawn');
    expect(c.phrase).toBeNull();
    expect(c.pins.map((x) => x.kind)).toEqual(['cup_trophy', 'achievement']);
    expect(c.timeAttack).toEqual([]);
  });
  it('my own card comes from my live state; a card that was never saved shows the basics on the default background', async () => {
    const w = world();
    await w.svc.bootstrap('v');
    await w.svc.bootstrap('n');
    const self = await w.service.card('n', 'n', 'ja');
    expect(self).toMatchObject({ state: 'ok', relation: 'self', reportable: false, horse: null, pins: [] });
    expect(self.background.id).toBe('dawn');
    const other = await w.service.card('v', 'n', 'ja');
    expect(other).toMatchObject({ state: 'ok', horse: null, pins: [], phrase: null });
    expect(neutralShowcase(m, 'x', 'en').background.backgroundName).toBe('Dawn track');
  });
});

describe('deletion, export, gate, KPI (REQ-SHOW-014..018)', () => {
  it('account deletion: the state key is classified for the export and forgotten; the copy leaves with the profile row', async () => {
    expect(classifyKey('showcase')).toEqual({ section: 'profile' });
    const w = world();
    const d = await decorated(w, 'a');
    await w.svc.showcaseSave('a', fullInput(d));
    const r = await w.svc.showcaseForget('a');
    expect(r).toEqual({ removed: true });
    expect((await w.svc.state('a')).showcase).toBeUndefined();
    expect((await w.dir.profiles(['a']))[0]!.showcase).toBeUndefined();
    const s = (await w.svc.state('a'));
    expect(forgetShowcase(s)).toEqual({ removed: false });
    expect(showcaseCopy(m, s, NOW)).toBeNull();
  });
  it('the routes are in the maintenance group social, never exempt', () => {
    for (const p of ['/v1/showcase', '/v1/showcase/u1']) { expect(endpointGroup(p)).toBe('social'); expect(isExempt('GET', p)).toBe(false); }
    expect(isExempt('PUT', '/v1/showcase')).toBe(false);
  });
  it('client events showcase_view / showcase_share are strict and carry no player id', () => {
    const ok = clientEventSchema.parse({ name: 'showcase_view', at: NOW, props: { source: 'cup_lobby', relation: 'other', neutral: false } });
    expect(clientToKpi(ok)).toEqual({ name: 'showcase_view', s1: 'cup_lobby', s2: 'other', s3: 'card' });
    expect(() => clientEventSchema.parse({ name: 'showcase_view', at: NOW, props: { source: 'friends', relation: 'other', neutral: false, playerId: 'u2' } })).toThrow();
    const sh = clientEventSchema.parse({ name: 'showcase_share', at: NOW, props: { pins: 3, records: 2, horse: true } });
    expect(clientToKpi(sh)).toEqual({ name: 'showcase_share', count: 3, value: 2, s1: 'horse' });
  });
});

describe('HTTP (REQ-SHOW-003/007/013)', () => {
  function ctx() {
    const dir = new MemoryDirectory();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() }, onProfile: (p) => dir.putProfile(p) });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
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
    return { c, svc };
  }
  const call = async (c: AppContext, user: string, path: string, method = 'GET', body?: unknown) => {
    const r = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': user, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, c);
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  it('GET / PUT /v1/showcase and GET /v1/showcase/:id, everything in English with ?lang=en (names stay as typed)', async () => {
    const { c, svc } = ctx();
    await svc.bootstrap('u1');
    await svc.grantPartner('u1', 'ミドリ', 'c:g1');
    await svc.bootstrap('u2');
    const mine = await call(c, 'u1', '/v1/showcase');
    expect(mine.status).toBe(200);
    const horseId = (mine.body.horses as { horseId: string }[])[0]!.horseId;
    const put = await call(c, 'u1', '/v1/showcase?lang=en', 'PUT', { horseId, pins: [], taTrackIds: [], phraseId: 'hello', backgroundId: 'dawn' });
    expect(put.status).toBe(200);
    expect(untranslated(put.body, new Set(['displayName', 'horseName']))).toEqual([]);
    const card = await call(c, 'u2', '/v1/showcase/u1?lang=en');
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ state: 'ok', phrase: { id: 'hello', phraseText: 'Nice to meet you!' }, horse: { horseName: 'ミドリ' } });
    expect(untranslated(card.body, new Set(['displayName', 'horseName']))).toEqual([]);
    // free text is refused by the schema (no field for it)
    expect((await call(c, 'u1', '/v1/showcase', 'PUT', { horseId: null, pins: [], taTrackIds: [], phraseId: null, backgroundId: 'dawn', text: 'hi' })).status).toBe(400);
    expect((await call(c, 'u1', '/v1/showcase', 'PUT', { horseId: null, pins: [{ kind: 'title', id: 'a' }, { kind: 'title', id: 'b' }, { kind: 'title', id: 'c' }, { kind: 'title', id: 'd' }], taTrackIds: [], phraseId: null, backgroundId: 'dawn' })).status).toBe(400);
  });
});
