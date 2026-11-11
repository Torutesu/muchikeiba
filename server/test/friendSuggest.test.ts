// REQ-FSUG-001..016: おすすめフレンド (contracts/protocol.md §49).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendSuggestService, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { catalogFor, enWordingProblems, localize, untranslated } from '../src/i18n/catalog.js';
import {
  FSUG_DEFAULTS, FSUG_KINDS, FSUG_TEXT, MemorySuggestDirectory, fsugCandidates, fsugCard, fsugConfig, fsugProblems, fsugSelf, fsugText, noteFsugRace,
  type FsugCache,
} from '../src/domain/friendSuggest.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { ensureFeed } from '../src/domain/teamFeed.js';
import { recordActivity } from '../src/domain/activity.js';
import { uxProblems } from '../src/domain/onboarding.js';
import type { Master } from '../src/domain/master.js';
import type { TeamsService } from '../src/domain/teamService.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const DAY = 86_400_000;
const withCfg = (patch: Record<string, unknown>): Master => ({ ...m, progression: { ...m.progression, friendSuggest: { ...FSUG_DEFAULTS, ...patch } } } as Master);

async function setup(master: Master = m, teams: Record<string, string[]> = {}) {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const dir = new MemoryDirectory();
  const cards = new MemorySuggestDirectory(dir);
  const kpi: { id: string; rec: KpiRecord }[] = [];
  let cardWrites = 0;
  const svc = new PlayerService(repo, {
    master, rng: seededRng(9), clock: () => now, verifiers: {}, onProfile: (p) => dir.putProfile(p),
    onFsugCard: async (id, card) => { cardWrites++; if (card) await cards.put(card); else await cards.remove(id); },
    onKpi: (id, recs) => { for (const rec of recs) kpi.push({ id, rec }); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const friends = makeFriendsService(() => invoker, dir);
  const teamStub = { view: async (teamId: string, viewer: string) => ({ myRole: teams[teamId]?.includes(viewer) ? 'member' : null, disbanded: false, members: (teams[teamId] ?? []).map((playerId) => ({ playerId })) }) } as unknown as TeamsService;
  const cache: FsugCache = new Map();
  const fsug = makeFriendSuggestService(() => invoker, friends, cards, teamStub, () => master, () => now, cache);
  const c: AppContext = {
    master,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends,
    friendSuggest: fsug,
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; lang?: string } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json', 'idempotency-key': `c:${path}:${Math.random()}`, ...(init.lang ? { 'accept-language': init.lang } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Every player touches the server once (profile + card published, as in production). */
  const join = async (id: string, name = `${id.toUpperCase()}`) => { await svc.setDisplayName(id, name.replace(/[^ァ-ヶー]/g, '') || 'テスト'); };
  const race = (id: string, raceId: string, mode: RaceResultForPlayer['mode'], field: string[], extra: Partial<RaceResultForPlayer> = {}) =>
    svc.applyRace(id, { raceId, mode, place: 1, fieldSize: field.length, newRating: null, void: false, humans: field.length, field: field.map((playerId, i) => ({ playerId, place: i + 1 })), ...extra });
  const befriend = async (a: string, b: string) => { const code = (await friends.myCode(b)).code; await friends.request(a, code); await friends.accept(b, a); };
  const list = async (u: string) => (await call(u, '/v1/friends/suggestions')).body;
  return { svc, repo, dir, cards, friends, fsug, cache, call, join, race, befriend, list, kpi, cardWrites: () => cardWrites, setNow: (t: number) => { now = t; }, now: () => now };
}

const NAMES: Record<string, string> = { me: 'ワタシ', a: 'アオイ', b: 'ベニ', c: 'チヒロ', d: 'ダイチ', e: 'エミ', f: 'フウカ', g: 'ゴウ', x: 'エックス', y: 'ワイ' };
async function joinAll(t: Awaited<ReturnType<typeof setup>>, ids: string[]) { for (const id of ids) await t.svc.setDisplayName(id, NAMES[id] ?? 'テスト'); }

describe('config (REQ-FSUG-012)', () => {
  it('the shipped config is valid and equals the defaults; bad values are reported', () => {
    expect(fsugProblems(m)).toEqual([]);
    expect(fsugConfig(m)).toEqual(FSUG_DEFAULTS);
    expect(fsugProblems(withCfg({ maxShown: 0 }))).toContain('progression.friendSuggest.maxShown must be an integer 1..30');
    expect(fsugProblems(withCfg({ candidateMax: 10, maxShown: 20 }))).toContain('progression.friendSuggest.candidateMax must be at least maxShown');
    expect(fsugProblems(withCfg({ weights: { ...FSUG_DEFAULTS.weights, team: 101 } }))).toContain('progression.friendSuggest.weights.team must be an integer 0..100');
    expect(fsugProblems(withCfg({ weights: { ...FSUG_DEFAULTS.weights, ranked: 5 } }))).toContain('progression.friendSuggest.weights.ranked is unknown');
    expect(fsugProblems(withCfg({ bogus: 1 }))).toContain('progression.friendSuggest.bogus is unknown');
    expect(fsugProblems(withCfg({ enabled: 'yes' }))).toContain('progression.friendSuggest.enabled must be a boolean');
    // boot / remote config validation goes through uxProblems
    expect(uxProblems(withCfg({ cacheTtlMs: -1 }), new Set()).some((x) => x.includes('friendSuggest.cacheTtlMs'))).toBe(true);
  });
});

describe('opponents (REQ-FSUG-013)', () => {
  it('records friend-room / event / tournament fields, never ranked, tutorial, time attack, challenge or void races', () => {
    const s = freshPlayer('me', NOW);
    noteFsugRace(m, s, { mode: 'ranked', void: false, field: [{ playerId: 'r1' }] }, NOW);
    noteFsugRace(m, s, { mode: 'tutorial', void: false, field: [{ playerId: 't1' }] }, NOW);
    noteFsugRace(m, s, { mode: 'challenge', void: false, field: [{ playerId: 'c1' }] }, NOW);
    noteFsugRace(m, s, { mode: 'friend', void: true, field: [{ playerId: 'v1' }] }, NOW);
    noteFsugRace(m, s, { mode: 'friend', void: false, field: [{ playerId: 'me' }, { playerId: 'a' }] }, NOW);
    noteFsugRace(m, s, { mode: 'event', void: false, field: [{ playerId: 'b' }] }, NOW + 1);
    noteFsugRace(m, s, { mode: 'tournament', void: false, field: [{ playerId: 'a' }] }, NOW + 2);
    expect(s.friendSuggest!.opponents.map((x) => [x.id, x.mode, x.n])).toEqual([['b', 'event', 1], ['a', 'tournament', 2]]);
  });

  it('Round 17 integration: hosted cup mates (confirmed cup races, §42) count as opponents', async () => {
    const s = freshPlayer('me', NOW);
    noteFsugRace(m, s, { mode: 'cup', void: false, field: [{ playerId: 'me' }, { playerId: 'a' }] }, NOW);
    noteFsugRace(m, s, { mode: 'cup', void: true, field: [{ playerId: 'v1' }] }, NOW);
    expect(s.friendSuggest!.opponents.map((x) => [x.id, x.mode])).toEqual([['a', 'cup']]);
    // through applyRace (the cup branch records only, but the suggestion signal is kept)
    const t = await setup();
    await joinAll(t, ['me', 'a', 'b']);
    await t.race('me', 'cup:c1:0:0', 'cup', ['me', 'a']);
    const l = await t.list('me');
    expect(l.items.map((x: { playerId: string; text: string }) => [x.playerId, x.text])).toEqual([['a', '最近のレースで対戦']]);
  });

  it('keeps at most opponentKeep and drops races older than opponentDays', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 70; i++) noteFsugRace(m, s, { mode: 'friend', void: false, field: [{ playerId: `p${i}` }] }, NOW + i);
    expect(s.friendSuggest!.opponents).toHaveLength(FSUG_DEFAULTS.opponentKeep);
    expect(s.friendSuggest!.opponents[0]!.id).toBe('p20');
    expect(fsugSelf(m, s, NOW + 31 * DAY).opponents).toHaveLength(0);
    noteFsugRace(m, s, { mode: 'friend', void: false, field: [{ playerId: 'late' }] }, NOW + 31 * DAY);
    expect(s.friendSuggest!.opponents.map((x) => x.id)).toEqual(['late']);
  });
});

describe('ranking (REQ-FSUG-002/003)', () => {
  it('is deterministic: score, then newest signal, then player id; reasons by contribution (max 2)', () => {
    const s = freshPlayer('me', NOW);
    s.friends.ids.push('f1', 'f2', 'f3');
    noteFsugRace(m, s, { mode: 'friend', void: false, field: [{ playerId: 'opp' }] }, NOW);
    recordActivity(m, s, { kind: 'stable_like', source: 'l1', actor: { id: 'liker' } }, NOW + 5);
    recordActivity(m, s, { kind: 'team_cheer', source: 'c1', actor: { id: 'cheer' } }, NOW + 1);
    const self = fsugSelf(m, s, NOW + 10);
    const cards = ['f1', 'f2', 'f3'].map((id) => ({ playerId: id, blocked: [], friends: ['me', 'mut3', 'mut1', ...(id !== 'f3' ? ['mut2'] : [])].sort(), updatedAt: NOW }));
    const out = fsugCandidates(m, self, ['me', 'mate', 'opp', 'f1'], cards);
    // opp: opponent 40 + team 30 = 70; mate (team), mut1 / mut3 (3 mutual) = 30 with no time → by id; liker 25 (newer) > cheer 25; mut2: 2 mutual = 20
    expect(out.map((x) => [x.id, x.score])).toEqual([['opp', 70], ['mate', 30], ['mut1', 30], ['mut3', 30], ['liker', 25], ['cheer', 25], ['mut2', 20]]);
    expect(out[0]!.reasons.map((r) => r.kind)).toEqual(['opponent', 'team']);
    expect(fsugText([{ kind: 'team' }, { kind: 'mutual', n: 3 }])).toBe('同じ支部・共通のフレンド3人');
    // the same data gives the same order again
    expect(fsugCandidates(m, self, ['me', 'mate', 'opp', 'f1'], cards).map((x) => x.id)).toEqual(out.map((x) => x.id));
  });

  it('a single mutual friend is not a reason (fofMin 2), the count is capped, a friend who blocked me is no bridge', () => {
    const s = freshPlayer('me', NOW);
    s.friends.ids.push('f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7');
    const card = (id: string, friends: string[], blocked: string[] = []) => ({ playerId: id, blocked, friends, updatedAt: NOW });
    const self = fsugSelf(m, s, NOW);
    const all = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map((id) => card(id, ['many']));
    let out = fsugCandidates(m, self, [], [...all, card('f1', ['solo'])]);
    expect(out.map((x) => [x.id, x.score, x.reasons[0]!.n])).toEqual([['many', 50, 7]]);
    out = fsugCandidates(m, self, [], [card('f1', ['two']), card('f2', ['two'], ['me'])]);
    expect(out).toEqual([]);
  });

  it('caps the candidates at candidateMax (fan-out bound)', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 100; i++) noteFsugRace(withCfg({ opponentKeep: 200 }), s, { mode: 'friend', void: false, field: [{ playerId: `p${String(i).padStart(3, '0')}` }] }, NOW + i);
    expect(fsugCandidates(m, fsugSelf(withCfg({ opponentKeep: 200 }), s, NOW + 200), [], [])).toHaveLength(FSUG_DEFAULTS.candidateMax);
  });
});

describe('GET /v1/friends/suggestions (REQ-FSUG-001/004..007/010)', () => {
  it('lists people met in friend rooms, events, tournaments, the branch, likes and cheers, with an honest reason; never ranked opponents', async () => {
    const t = await setup(m, { team1: ['me', 'b'] });
    await joinAll(t, ['me', 'a', 'b', 'c', 'd', 'e', 'x']);
    await t.svc.tx('me', null, (s) => { s.team = { teamId: 'team1', joinedAt: NOW, cooldownUntil: 0, joining: null, outgoing: [], rewarded: [] }; });
    await t.race('me', 'r1', 'friend', ['me', 'a']);
    await t.race('me', 'r2', 'ranked', ['me', 'x']);
    await t.svc.stableLikeReceive('me', 'c', 'like1');
    await t.svc.cheerPush('me', 'd', 'ダイチ', 'team1:7');
    const body = await t.list('me');
    expect(body.enabled).toBe(true);
    expect(body.settings).toEqual({ hidden: false });
    expect(body.items.map((x: any) => [x.playerId, x.text])).toEqual([
      ['a', '最近のレースで対戦'], ['b', '同じ支部'], ['c', 'マイ厩舎にいいねをくれた'], ['d', '応援スタンプをくれた'],
    ]);
    expect(body.items[0]).toMatchObject({ displayName: 'アオイ', classId: expect.any(String), reasons: [{ kind: 'opponent' }] });
    // never: rating, stats, card contents
    for (const it of body.items) { expect(it).not.toHaveProperty('rating'); expect(it).not.toHaveProperty('stats'); expect(it).not.toHaveProperty('blocked'); expect(it).not.toHaveProperty('friends'); expect(it).not.toHaveProperty('score'); }
  });

  it('English reasons at the boundary, names untranslated, nothing Japanese left', async () => {
    const t = await setup(m, { team1: ['me', 'b'] });
    await joinAll(t, ['me', 'a', 'b', 'f1', 'f2', 'm1']);
    await t.svc.tx('me', null, (s) => { s.team = { teamId: 'team1', joinedAt: NOW, cooldownUntil: 0, joining: null, outgoing: [], rewarded: [] }; });
    await t.befriend('me', 'f1'); await t.befriend('me', 'f2'); await t.befriend('f1', 'b'); await t.befriend('f2', 'b');
    await t.race('me', 'r1', 'event', ['me', 'a']);
    const res = await t.call('me', '/v1/friends/suggestions', { lang: 'en' });
    expect(res.body.items.map((x: any) => x.text)).toEqual(['Same branch, 2 mutual friends', 'Raced you recently']);
    expect(res.body.items.map((x: any) => x.displayName)).toEqual(['ベニ', 'アオイ']);
    expect(untranslated(res.body, new Set(['displayName']))).toEqual([]);
    const cat = catalogFor(m);
    for (const k of FSUG_KINDS) {
      const en = localize(FSUG_TEXT[k].replace('{n}', '3'), 'en', cat);
      expect(untranslated(en)).toEqual([]);
      expect(enWordingProblems(en)).toEqual([]);
    }
    expect(localize('共通のフレンド1人', 'en', cat)).toBe('1 mutual friend');
  });

  it('excludes self, friends, pending both ways, dismissed, and both directions of a block', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    await t.race('me', 'r1', 'friend', ['me', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    await t.befriend('me', 'a');
    await t.friends.request('me', (await t.friends.myCode('b')).code); // outgoing
    await t.friends.request('c', (await t.friends.myCode('me')).code); // incoming
    await t.call('me', '/v1/friends/suggestions/d/dismiss', { method: 'POST' });
    await t.svc.tx('me', null, (s) => { ensureFeed(s).muted.push('e'); }); // I blocked e
    await t.svc.tx('f', null, (s) => { ensureFeed(s).muted.push('me'); }); // f blocked me
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['g']);
  });

  it('hidden (opt-out), registered under 13, banned, deletion scheduled and deleted players never appear; I see none while my deletion is scheduled', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a', 'b', 'c', 'd', 'e', 'g']);
    await t.race('me', 'r1', 'tournament', ['me', 'a', 'b', 'c', 'd', 'e', 'g']);
    expect((await t.list('me')).items).toHaveLength(6);
    expect((await t.call('a', '/v1/friends/suggestions/settings', { method: 'PUT', body: { hidden: true } })).body).toEqual({ hidden: true });
    await t.svc.tx('b', null, (s) => { s.age = { birthYear: 2015, birthMonth: 1, guardianConsent: true, setAt: NOW }; });
    await t.svc.tx('c', null, (s) => { s.moderation = { status: 'banned', until: null, reason: 'test', at: NOW } as unknown as typeof s.moderation; });
    await t.svc.tx('d', null, (s) => { s.deletion = { status: 'scheduled', requestedAt: NOW, deleteAt: NOW + 30 * DAY, steps: [], attempts: 0 } as unknown as typeof s.deletion; });
    await t.cards.remove('e'); // e: no card (e.g. a deleted account: forget removed it)
    t.cache.clear();
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['g']);
    // a card whose public profile is gone (deleted) or marked banned is dropped too
    await t.cards.put({ playerId: 'ghost', blocked: [], friends: [], updatedAt: NOW });
    await t.race('me', 'r2', 'friend', ['me', 'ghost']);
    t.cache.clear();
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['g']);
    // an adult (18) is shown; opt-out can be turned off again
    await t.call('a', '/v1/friends/suggestions/settings', { method: 'PUT', body: { hidden: false } });
    t.cache.clear();
    expect((await t.list('me')).items.map((x: any) => x.playerId).sort()).toEqual(['a', 'g']);
    // my own deletion scheduled → empty list, no request
    await t.svc.tx('me', null, (s) => { s.deletion = { status: 'scheduled', requestedAt: NOW, deleteAt: NOW + 30 * DAY, steps: [], attempts: 0 } as unknown as typeof s.deletion; });
    expect((await t.list('me')).items).toEqual([]);
    expect((await t.call('me', '/v1/friends/suggestions/g/request', { method: 'POST' })).status).toBe(404);
  });

  it('an opted-out friend is no mutual-friend bridge', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'f1', 'f2', 'b']);
    await t.befriend('me', 'f1'); await t.befriend('me', 'f2'); await t.befriend('f1', 'b'); await t.befriend('f2', 'b');
    expect((await t.list('me')).items.map((x: any) => x.text)).toEqual(['共通のフレンド2人']);
    await t.svc.fsugSetHidden('f2', true);
    t.cache.clear();
    expect((await t.list('me')).items).toEqual([]);
  });

  it('caches per player for cacheTtlMs, but own-state exclusions apply at once; the disabled config shows nothing', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a', 'b']);
    await t.race('me', 'r1', 'friend', ['me', 'a', 'b']);
    expect((await t.list('me')).items).toHaveLength(2);
    // a new opponent within the TTL is not computed yet …
    t.setNow(NOW + 1000);
    await joinAll(t, ['c']);
    await t.race('me', 'r2', 'friend', ['me', 'c']);
    expect((await t.list('me')).items).toHaveLength(2);
    // … but my own block is applied right away from fresh state
    await t.svc.tx('me', null, (s) => { ensureFeed(s).muted.push('a'); });
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['b']);
    t.setNow(NOW + FSUG_DEFAULTS.cacheTtlMs + 1);
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['c', 'b']);
    const off = await setup(withCfg({ enabled: false }));
    await joinAll(off, ['me', 'a']);
    await off.race('me', 'r1', 'friend', ['me', 'a']);
    expect(await off.list('me')).toEqual({ enabled: false, items: [], settings: { hidden: false } });
  });

  it('cards are written when they change (block list, friends, visibility) or with the periodic profile push, not on every transaction', async () => {
    const t = await setup();
    await t.join('me');
    const n0 = t.cardWrites();
    expect(n0).toBe(1);
    await t.svc.tx('me', null, () => undefined);
    expect(t.cardWrites()).toBe(n0);
    // a lost write heals with the next profile push
    await t.cards.remove('me');
    t.setNow(NOW + m.progression.social.profilePushIntervalMs + 1);
    await t.svc.tx('me', null, () => undefined);
    expect(t.cards.store.has('me')).toBe(true);
    const n1 = t.cardWrites();
    await t.svc.tx('me', null, (s) => { ensureFeed(s).muted.push('z'); });
    expect(t.cardWrites()).toBe(n1 + 1);
    expect(t.cards.store.get('me')!.blocked).toEqual(['z']);
    await t.svc.fsugSetHidden('me', true);
    expect(t.cards.store.has('me')).toBe(false);
    expect(fsugCard(m, (t.repo.get('me'))!, NOW)).toBeNull();
  });
});

describe('request / dismiss (REQ-FSUG-008/009/014) and the activity entries (§40)', () => {
  it('a request goes through the friend request flow: activity + push for the other side; never suggested again, even after a decline', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a']);
    await t.svc.registerDevice('a', 'tok-aaaaaaaa', 'ios');
    await t.race('me', 'r1', 'friend', ['me', 'a']);
    const r = await t.call('me', '/v1/friends/suggestions/a/request', { method: 'POST' });
    expect(r).toEqual({ status: 200, body: { status: 'requested', playerId: 'a' } });
    // §40: the receiver's activity entry and push came from friendReceive
    const act = await t.call('a', '/v1/activity');
    expect(act.body.items[0]).toMatchObject({ kind: 'friend_request', actors: [{ playerId: 'me', name: 'ワタシ' }] });
    expect((t.repo.get('a') as any).push?.outbox?.map((o: any) => o.templateId)).toContain('friend_request');
    expect((await t.call('me', '/v1/friends')).body.outgoing.map((x: any) => x.playerId)).toEqual(['a']);
    // retry: the same answer, nothing sent again
    expect((await t.call('me', '/v1/friends/suggestions/a/request', { method: 'POST' })).body).toEqual({ status: 'requested', playerId: 'a' });
    expect((await t.call('a', '/v1/activity')).body.items.filter((x: any) => x.kind === 'friend_request')).toHaveLength(1);
    expect(t.kpi.filter((k) => k.rec.name === 'fsug_request').map((k) => [k.id, k.rec.s1, k.rec.s2])).toEqual([['me', 'opponent', 'requested']]);
    // a declines; a is still not suggested again
    await t.friends.decline('a', 'me');
    t.cache.clear();
    expect((await t.list('me')).items).toEqual([]);
  });

  it('accepting: the requester gets the friend_accepted activity entry; a mutual request answers friends', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a']);
    await t.race('me', 'r1', 'friend', ['me', 'a']);
    await t.race('a', 'r1', 'friend', ['me', 'a']);
    await t.call('me', '/v1/friends/suggestions/a/request', { method: 'POST' });
    await t.call('a', '/v1/friends/requests/me/accept', { method: 'POST' });
    expect((await t.call('me', '/v1/activity')).body.items[0]).toMatchObject({ kind: 'friend_accepted' });
    // b asked me by code; b met me in an event: suggestion request answers friends at once (mutual)
    await joinAll(t, ['b']);
    await t.race('me', 'r2', 'event', ['me', 'b']);
    await t.friends.request('b', (await t.friends.myCode('me')).code);
    // pending incoming → not suggested → 404 (accept it from the requests list instead)
    expect((await t.call('me', '/v1/friends/suggestions/b/request', { method: 'POST' })).status).toBe(404);
  });

  it('only someone suggestable right now: unknown ids, strangers, self and anyone who blocked me get 404 (no reason)', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a', 'stranger']);
    await t.race('me', 'r1', 'friend', ['me', 'a']);
    expect((await t.list('me')).items).toHaveLength(1); // cached with a
    await t.svc.tx('a', null, (s) => { ensureFeed(s).muted.push('me'); });
    // the cached list may still show a until the TTL, but the request is checked without the cache
    expect((await t.call('me', '/v1/friends/suggestions/a/request', { method: 'POST' })).status).toBe(404);
    expect((await t.call('me', '/v1/friends/suggestions/stranger/request', { method: 'POST' })).status).toBe(404);
    expect((await t.call('me', '/v1/friends/suggestions/me/request', { method: 'POST' })).status).toBe(404);
    expect((await t.call('me', '/v1/friends/suggestions/nobody/request', { method: 'POST' })).status).toBe(404);
    expect((await t.call('me', '/v1/friends')).body.outgoing).toEqual([]);
  });

  it('the friend limits of the request flow apply (FRIEND_LIMIT)', async () => {
    const tight = { ...m, progression: { ...m.progression, social: { ...m.progression.social, maxOutgoing: 1 } } } as Master;
    const u = await setup(tight);
    await joinAll(u, ['me', 'a', 'b']);
    await u.race('me', 'r1', 'friend', ['me', 'a', 'b']);
    expect((await u.call('me', '/v1/friends/suggestions/a/request', { method: 'POST' })).status).toBe(200);
    const r = await u.call('me', '/v1/friends/suggestions/b/request', { method: 'POST' });
    expect(r.body.error?.code ?? r.body.code).toBe('FRIEND_LIMIT');
  });

  it('dismiss is idempotent, remembered (bounded), one KPI row; the setting body is strict', async () => {
    const t = await setup();
    await joinAll(t, ['me', 'a', 'b']);
    await t.race('me', 'r1', 'friend', ['me', 'a', 'b']);
    await t.list('me');
    expect((await t.call('me', '/v1/friends/suggestions/a/dismiss', { method: 'POST' })).body).toEqual({ ok: true });
    expect((await t.call('me', '/v1/friends/suggestions/a/dismiss', { method: 'POST' })).body).toEqual({ ok: true });
    expect(t.kpi.filter((k) => k.rec.name === 'fsug_dismiss').map((k) => k.rec.s1)).toEqual(['opponent']);
    expect((await t.list('me')).items.map((x: any) => x.playerId)).toEqual(['b']);
    expect((await t.call('me', '/v1/friends/suggestions/me/dismiss', { method: 'POST' })).status).toBe(400);
    expect((await t.call('me', '/v1/friends/suggestions/settings', { method: 'PUT', body: { hidden: true, extra: 1 } })).status).toBe(400);
    expect((await t.call('me', '/v1/friends/suggestions/settings', { method: 'PUT', body: { hidden: 'yes' } })).status).toBe(400);
    // bounded
    await t.svc.tx('me', null, (s) => { for (let i = 0; i < 250; i++) s.friendSuggest!.dismissed.push({ id: `z${i}`, at: NOW, why: 'dismiss' }); });
    await t.svc.fsugDismiss('me', 'zz', 'dismiss', 'none');
    expect((t.repo.get('me'))!.friendSuggest!.dismissed).toHaveLength(FSUG_DEFAULTS.dismissKeep);
  });

  it('fsug_view is a client event (shown count) with no player id', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'fsug_view', at: NOW, props: { shown: 4 } }] });
    expect(clientToKpi(b.events[0]!)).toEqual({ name: 'fsug_view', value: 4 });
    expect(() => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'fsug_view', at: NOW, props: { shown: 4, playerId: 'a' } }] })).toThrow();
  });
});
