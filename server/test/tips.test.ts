// REQ-TUT-001..018: チュートリアルのやり直しとヒント集 (contracts/protocol.md §57).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { resolveBundle } from '../src/ops/config.js';
import { BASE_HELP, type HelpMaster } from '../src/domain/help.js';
import { BASE_TIPS, RACE_LESSONS, TIP_CONTEXTS, markTipsSeen, tipsBadge, tipsIndex, tipsProblems, type TipsMaster } from '../src/domain/tips.js';
import { findBanner, oddsDisclosure } from '../src/domain/gacha.js';
import { TIP_CONTEXT_NAMES, clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { DEFAULT_MAINTENANCE, endpointGroup, gateRequest, isExempt, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { newPlayer } from '../src/domain/player.js';
import { seasonIdFor } from '../src/domain/season.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const DAY = 86_400_000;
const JP = /[぀-ヿ㐀-鿿]/;
const clone = (): TipsMaster => structuredClone(BASE_TIPS);
const withTips = (t: TipsMaster, base: Master = m): Master => ({ ...base, tips: t });
const fresh = (now = NOW): PlayerState => newPlayer('p1', now, seasonIdFor(now));
const tip = (t: TipsMaster, id: string) => t.tips.find((x) => x.id === id)!;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function setup(master: Master = m) {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(19), clock: () => now, verifiers: { fake: store }, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c: AppContext = {
    master,
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
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; key?: string; lang?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (init.key) headers['idempotency-key'] = init.key;
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  let n = 0;
  const race = (id: string, place: number) => svc.applyRace(id, { raceId: `r${++n}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 1 });
  return { svc, repo, kpi, call, race, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('the shipped tips master (REQ-TUT-010..013)', () => {
  it('passes every check: topics, ids, unlock keys, art, lengths, tokens, wording, help links, no repeated help text', () => {
    expect(tipsProblems(m)).toEqual([]);
    const t = BASE_TIPS;
    expect(t.topics.map((x) => x.id).sort()).toEqual(['horses', 'race', 'scout', 'shop', 'social']);
    expect(t.tutorials.filter((x) => x.kind === 'race').map((x) => x.lesson).sort()).toEqual([...RACE_LESSONS].sort());
    for (const k of TIP_CONTEXTS) expect(t.tips.some((x) => x.id === t.contexts[k])).toBe(true);
    // the feature tours named in the spec: breeding, training, scout (rates & pity), shop & coin types, teams, cups
    expect(t.tutorials.filter((x) => x.kind === 'tour').map((x) => x.id).sort()).toEqual(['tour_breeding', 'tour_cups', 'tour_scout', 'tour_shop', 'tour_teams', 'tour_training']);
    // tips are short, help is long: every card body is shorter than the article it links to
    for (const x of t.tips) {
      const a = BASE_HELP.articles.find((y) => y.id === x.help)!;
      expect(a, x.id).toBeDefined();
      for (const lang of ['ja', 'en'] as const) expect([...x.body[lang]].length, `${x.id}.${lang}`).toBeLessThan([...a.body[lang]].length);
    }
    // the KPI's context list is the domain's
    expect([...TIP_CONTEXT_NAMES]).toEqual([...TIP_CONTEXTS]);
  });

  const broken = (f: (t: TipsMaster) => void) => { const t = clone(); f(t); return tipsProblems(withTips(t)).join('\n'); };
  it('refuses shop words, urgency, betting words and English wording', () => {
    expect(broken((t) => { tip(t, 'coins_paid_free').body.ja += '今ならお得'; })).toMatch(/shop word 「お得」/);
    expect(broken((t) => { tip(t, 'whip_window').title.ja = 'ムチで2倍'; })).toMatch(/shop word 「倍」/);
    expect(broken((t) => { tip(t, 'whip_window').body.ja += '今だけ'; })).toMatch(/今だけ/);
    expect(broken((t) => { tip(t, 'scout_rates_tip').body.ja += 'オッズを確認'; })).toMatch(/betting word オッズ/);
    expect(broken((t) => { tip(t, 'scout_rates_tip').body.en += ' Check the odds.'; })).toMatch(/betting word/);
    expect(broken((t) => { tip(t, 'coins_paid_free').body.en += ' Limited time!'; })).toMatch(/wording/);
  });
  it('numbers come from tokens: no digits in scout / shop cards, no number with a unit anywhere, known tokens only', () => {
    expect(broken((t) => { tip(t, 'scout_pity_tip').body.ja = '常設では200回分で交換できる。'; })).toMatch(/number with a unit|may not carry numbers/);
    expect(broken((t) => { tip(t, 'coins_paid_order').body.en = 'Paid coins are used first, 3 at a time.'; })).toMatch(/may not carry numbers/);
    expect(broken((t) => { tip(t, 'whip_spacing').body.ja = 'ムチは6回まで。'; })).toMatch(/number with a unit/);
    expect(broken((t) => { tip(t, 'scout_pity_tip').body.ja += '{{rate:nope:SSR}}'; tip(t, 'scout_pity_tip').body.en += '{{rate:nope:SSR}}'; })).toMatch(/unknown banner nope/);
    expect(broken((t) => { tip(t, 'scout_pity_tip').body.en = 'Pull for exchange points.'; })).toMatch(/different tokens/);
    expect(broken((t) => { tip(t, 'whip_window').body.ja += '{{oops'; })).toMatch(/malformed token/);
  });
  it('keeps cards short and never repeats a help article sentence (link it instead)', () => {
    expect(broken((t) => { tip(t, 'whip_window').body.ja = 'あ'.repeat(161); })).toMatch(/1\.\.160 characters/);
    const helpSentence = BASE_HELP.articles.find((a) => a.id === 'buy_coins')!.body.ja.split('\n').find((l) => l.includes('有償コインに有効期限'))!.replace(/^・/, '');
    expect(broken((t) => { tip(t, 'coins_paid_order').body.ja = `${helpSentence}。`; })).toMatch(/repeats a help article sentence/);
    expect(broken((t) => { tip(t, 'whip_window').help = 'nope'; })).toMatch(/help article nope does not exist/);
  });
  it('refuses unknown ids, topics, unlock keys, art, contexts and broken replays', () => {
    expect(broken((t) => { t.tips.push(structuredClone(t.tips[0]!)); })).toMatch(/duplicate id/);
    expect(broken((t) => { tip(t, 'whip_window').topic = 'misc' as never; })).toMatch(/unknown topic/);
    expect(broken((t) => { tip(t, 'breeding_pair').unlock = 'gacha_party' as never; })).toMatch(/unknown unlock key/);
    expect(broken((t) => { tip(t, 'breeding_pair').art = 'rainbow'; })).toMatch(/unknown art/);
    expect(broken((t) => { tip(t, 'whip_window').body.en = 'ムチ'; })).toMatch(/en contains Japanese/);
    expect(broken((t) => { t.contexts.gacha_odds = 'nope'; })).toMatch(/contexts.gacha_odds: unknown tip/);
    expect(broken((t) => { delete (t.contexts as Record<string, string>).training; })).toMatch(/contexts: missing training/);
    expect(broken((t) => { t.tutorials = t.tutorials.filter((x) => x.lesson !== 'reins'); })).toMatch(/lesson reins must appear exactly once/);
    expect(broken((t) => { t.tutorials.find((x) => x.id === 'tour_scout')!.tips.push('nope'); })).toMatch(/unknown tip nope/);
    expect(broken((t) => { t.tutorials.find((x) => x.id === 'race_whip')!.unlock = 'breeding'; })).toMatch(/open from the start/);
    expect(broken((t) => { t.config.seenMax = 5; })).toMatch(/seenMax/);
    expect(broken((t) => { t.config.seenPerRequest = 10; })).toMatch(/seenPerRequest must be an integer 20\.\.50/); // clients batch 20
  });
  it('remote config: a valid replacement applies; a broken card, or a help change that drops a linked article, refuses the version', () => {
    const t = clone();
    tip(t, 'whip_window').title.ja = '光ったらムチ（改訂）';
    expect(tipsIndex(resolveBundle(m, { tips: t as unknown as Record<string, unknown> }).master, fresh(), NOW, 'ja').tips[0]!.title).toBe('光ったらムチ（改訂）');
    const bad = clone();
    tip(bad, 'whip_window').body.ja += 'お得';
    expect(() => resolveBundle(m, { tips: bad as unknown as Record<string, unknown> })).toThrow(/tips\.tips/);
    const h: HelpMaster = structuredClone(BASE_HELP);
    h.articles = h.articles.filter((a) => a.id !== 'hosted_cups');
    expect(() => resolveBundle(m, { help: h as unknown as Record<string, unknown> })).toThrow(/help article hosted_cups does not exist/);
  });
});

describe('the index (REQ-TUT-005/006)', () => {
  it('fills numbers from the same data as the rates screen, in each language', () => {
    const d = oddsDisclosure(m, findBanner(m, 'standard'));
    const ja = tipsIndex(m, fresh(), NOW, 'ja');
    const en = tipsIndex(m, fresh(), NOW, 'en');
    expect(ja.tips.find((x) => x.id === 'scout_pity_tip')!.body).toContain(`${d.pity.pullsRequired.toLocaleString('en-US')}回分`);
    expect(en.tips.find((x) => x.id === 'scout_rates_tip')!.body).toContain(d.rarityTotals.SSR!.rate);
    expect(ja.tips.find((x) => x.id === 'whip_spacing')!.body).toContain(`${DEFAULT_RULESET.maxWhips}回まで`);
    expect(JP.test(JSON.stringify(en))).toBe(false);
    expect(JSON.stringify(ja)).not.toMatch(/\{\{|今だけ|お得|倍|残りわずか|オッズ/);
  });
  it('opens cards and tours with the §4.3 unlocks; a closed card shows its title and key, never its text', async () => {
    const x = setup();
    let v = await x.svc.tips('p', 'ja');
    const byId = (id: string) => v.tips.find((t) => t.id === id)!;
    expect(byId('whip_window')).toMatchObject({ unlocked: true, new: true });
    expect(byId('scout_pity_tip')).toMatchObject({ unlocked: true });
    expect(byId('breeding_pair')).toMatchObject({ unlocked: false, new: false, body: null, unlock: 'breeding' });
    expect(byId('breeding_pair').title).toBe('配合のきほん');
    expect(v.tutorials.filter((t) => t.unlocked).map((t) => t.id).sort()).toEqual(['race_position', 'race_reins', 'race_stamina', 'race_whip', 'tour_scout']);
    expect(byId('whip_window').help).toEqual({ articleId: 'whip', title: 'ムチのタイミング' });
    const before = v.newCount;
    for (let i = 0; i < 3; i++) await x.race('p', 4); // shop + training open after the 3rd race
    v = await x.svc.tips('p', 'ja');
    expect(byId('coins_paid_free').unlocked).toBe(true);
    expect(byId('training_timing')).toMatchObject({ unlocked: true, new: true });
    expect(v.newCount).toBeGreaterThan(before);
    expect(v.tutorials.find((t) => t.id === 'tour_shop')!.unlocked).toBe(true);
    x.advance(DAY); // day 2: breeding
    v = await x.svc.tips('p', 'ja');
    expect(byId('breeding_pair').unlocked).toBe(true);
    expect(byId('breeding_stud').unlocked).toBe(false); // after 3 breedings
    // the topic counts and the settings badge agree with the cards
    expect(v.topics.reduce((a, t) => a + t.newCount, 0)).toBe(v.newCount);
    expect((await x.svc.view('p')).tips).toEqual({ newCount: v.newCount });
  });
  it('off: an empty library, a zero badge, and marking is refused', async () => {
    const t = clone(); t.config.enabled = false;
    const mm = withTips(t);
    expect(tipsIndex(mm, fresh(), NOW, 'ja')).toMatchObject({ enabled: false, tips: [], tutorials: [], topics: [], contexts: {}, newCount: 0 });
    expect(tipsBadge(mm, fresh(), NOW)).toEqual({ newCount: 0 });
    expect(() => markTipsSeen(mm, fresh(), ['whip_window'], NOW)).toThrow(/not available/);
  });
});

describe('seen cards (REQ-TUT-007)', () => {
  it('marks open cards once, skips closed ones, refuses unknown ids without marking anything', async () => {
    const x = setup();
    const r = await x.svc.tipsSeen('p', ['whip_window', 'whip_window', 'breeding_pair']);
    expect(r).toMatchObject({ marked: ['whip_window'], skipped: ['breeding_pair'] });
    expect((await x.svc.tipsSeen('p', ['whip_window'])).marked).toEqual([]); // idempotent
    expect(await code(x.svc.tipsSeen('p', ['whip_spacing', 'nope']))).toBe('NOT_FOUND');
    const s = JSON.parse(x.repo.data.get('p')!) as PlayerState;
    expect(s.tips!.seen).toEqual(['whip_window']);
    const v = await x.svc.tips('p', 'ja');
    expect(v.tips.find((t) => t.id === 'whip_window')!.new).toBe(false);
    expect(v.newCount).toBe(r.newCount);
  });
  it('the list stays bounded and drops ids the master no longer has', () => {
    const s = fresh();
    s.tips = { seen: [...Array.from({ length: 300 }, (_, i) => `gone_${i}`)] };
    markTipsSeen(m, s, ['whip_window'], NOW);
    expect(s.tips.seen).toEqual(['whip_window']);
    const t = clone(); t.config.seenMax = 20;
    const s2 = fresh(NOW - 30 * DAY);
    s2.onboarding = { races: 100, breedings: 5, counts: {}, claimed: [] };
    s2.rating.rankedRaces = 50;
    const ids = t.tips.map((y) => y.id);
    for (let i = 0; i < ids.length; i += 20) markTipsSeen(withTips(t), s2, ids.slice(i, i + 20), NOW);
    expect(s2.tips!.seen).toHaveLength(20);
    expect(s2.tips!.seen).toEqual(ids.slice(-20));
    expect(() => markTipsSeen(withTips(t), s2, ids.slice(0, 21), NOW)).toThrow(/1\.\.20 ids/);
  });
});

describe('HTTP (REQ-TUT-005/007) and the gate group (REQ-TUT-016)', () => {
  it('GET /v1/tips in the request language, POST /v1/tips/seen with strict bodies, the badge on /v1/player', async () => {
    const x = setup();
    const ja = await x.call('u1', '/v1/tips');
    expect(ja.status).toBe(200);
    expect(ja.body.tips.find((t: { id: string }) => t.id === 'whip_window').title).toBe('光ったら、ムチ');
    const en = await x.call('u1', '/v1/tips?lang=en');
    expect(JP.test(JSON.stringify(en.body))).toBe(false);
    expect((await x.call('u1', '/v1/tips/seen', { method: 'POST', body: { ids: ['whip_window'] } })).body).toMatchObject({ marked: ['whip_window'] });
    expect((await x.call('u1', '/v1/tips/seen', { method: 'POST', body: { ids: [] } })).status).toBe(400);
    expect((await x.call('u1', '/v1/tips/seen', { method: 'POST', body: { ids: ['Bad Id'] } })).status).toBe(400);
    expect((await x.call('u1', '/v1/tips/seen', { method: 'POST', body: { ids: ['whip_window'], extra: 1 } })).status).toBe(400);
    expect((await x.call('u1', '/v1/tips/seen', { method: 'POST', body: { ids: ['nope_nope'] } })).status).toBe(404);
    expect((await x.call('u1', '/v1/player')).body.tips.newCount).toBe(ja.body.newCount - 1);
  });
  it('is in gate group core: a scoped window leaves it open, `all` closes it, it is not a support route', () => {
    for (const p of ['/v1/tips', '/v1/tips/seen']) expect(endpointGroup(p)).toBe('core');
    expect(isExempt('GET', '/v1/tips')).toBe(false);
    expect(isExempt('POST', '/v1/tips/seen')).toBe(false);
    const START = NOW + 3600_000;
    const cfg = (scope: MaintenanceConfig['windows'][number]['scope']): MaintenanceConfig => ({
      ...structuredClone(DEFAULT_MAINTENANCE),
      windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * 3600_000, scope, message: { ja: 'メンテナンス中です', en: 'Under maintenance' } }],
    });
    const h = { platform: null, version: null, engine: null };
    expect(gateRequest(cfg(['gacha', 'shop', 'ranked']), 'GET', '/v1/tips', h, START + 1)).toBeNull();
    expect(gateRequest(cfg('all'), 'GET', '/v1/tips', h, START + 1)?.code).toBe('MAINTENANCE');
  });
});

describe('KPI (REQ-TUT-015)', () => {
  const kpi = (name: string, props: Record<string, unknown>) => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [{ name, at: NOW, props }] }).events.map(clientToKpi)[0];
  it('tutorial_replay (which), tip_view (id, source), tip_context_open (screen, card)', () => {
    expect(kpi('tutorial_replay', { tutorialId: 'race_whip', kind: 'race', stage: 'start' })).toEqual({ name: 'tutorial_replay', s1: 'race_whip', s2: 'race', s3: 'start' });
    expect(kpi('tip_view', { tipId: 'scout_pity_tip', source: 'context' })).toEqual({ name: 'tip_view', s1: 'scout_pity_tip', s2: 'context' });
    expect(kpi('tip_context_open', { context: 'roster_bulk_retire', tipId: 'roster_retire' })).toEqual({ name: 'tip_context_open', s1: 'roster_bulk_retire', s2: 'roster_retire' });
    expect(() => kpi('tip_context_open', { context: 'home', tipId: 'x1' })).toThrow();
    expect(() => kpi('tutorial_replay', { tutorialId: 'race_whip', kind: 'race', stage: 'win' })).toThrow();
    expect(() => kpi('tip_view', { tipId: 'whip_window', source: 'list', reward: 1 })).toThrow();
  });
});

describe('replays never grant again (REQ-TUT-004)', () => {
  it('after the FTUE, replay KPI and tips calls change nothing but the seen list; the one-time rewards stay one-time', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    await x.svc.grantPartner('p', 'アカツキ', 'c:/v1/player/partner:1');
    await x.svc.tutorialDraw('p', 'c:/v1/gacha/tutorial:1');
    await x.race('p', 1);
    const snap = (s: PlayerState) => JSON.stringify({ wallet: s.wallet, horses: s.horses.map((h) => h.id), flags: s.flags, onboarding: s.onboarding, items: s.items, stats: s.stats, rating: s.rating, season: s.season, missions: s.missions, pass: s.seasonPass });
    const before = snap(JSON.parse(x.repo.data.get('p')!));
    for (const t of BASE_TIPS.tutorials) {
      await x.svc.kpiIngest('p', { platform: 'ios', appVersion: '1.0.0', events: [
        { name: 'tutorial_replay', at: x.now(), props: { tutorialId: t.id, kind: t.kind, stage: 'start' } },
        { name: 'tutorial_replay', at: x.now(), props: { tutorialId: t.id, kind: t.kind, stage: 'finish' } },
      ] });
    }
    await x.svc.tips('p', 'ja');
    await x.svc.tipsSeen('p', ['whip_window', 'whip_spacing']);
    expect(snap(JSON.parse(x.repo.data.get('p')!))).toBe(before);
    expect(x.kpi.filter((k) => k.name === 'tutorial_replay')).toHaveLength(BASE_TIPS.tutorials.length * 2);
    // the first-time rewards cannot be earned again
    expect(await code(x.svc.grantPartner('p', 'ハヤテ', 'c:/v1/player/partner:2'))).toBe('PARTNER_ALREADY_GRANTED');
    expect(await code(x.svc.tutorialDraw('p', 'c:/v1/gacha/tutorial:2'))).toBe('TUTORIAL_GACHA_USED');
    // a tutorial-mode race (the server-hosted tutorial) never counts toward the races / unlocks and pays nothing
    const races = JSON.parse(x.repo.data.get('p')!).onboarding.races;
    const r = await x.svc.applyRace('p', { raceId: 'tut-2', mode: 'tutorial', place: 1, fieldSize: 8, newRating: null, void: false, humans: 1 });
    expect((r as { coins?: number }).coins ?? 0).toBe(0);
    expect(JSON.parse(x.repo.data.get('p')!).onboarding.races).toBe(races);
  });
});
