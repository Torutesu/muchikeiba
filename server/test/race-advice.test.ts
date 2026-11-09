// REQ-ADV-001..016: 出走前アドバイス (contracts/protocol.md §39).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET, DISTANCE_RULESET_KEYS } from '../src/domain/ruleset.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { hasJapanese } from '../src/i18n/locale.js';
import { clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { goingsFor, type Going } from '../src/domain/schemas.js';
import {
  ADVICE_BANNED_EN, ADVICE_BANNED_JA, ADVICE_MODES, adviceCourse, adviceRules, adviceTextProblems, adviceTexts, computeRaceAdvice, goingSpecialistPermille,
  tutorialAdvice, type AdviceInput, type AdviceOutput,
} from '../src/domain/raceAdvice.js';
import { adviceHorse } from '../src/domain/raceAdviceService.js';
import { adviceVectorsJson } from '../src/domain/raceAdviceVectors.js';
import { freshPlayer, m } from './helpers.js';

const TMP = freshPlayer('tmp');
const INSTANCES = m.templates.map((t) => createHorseFromTemplate(TMP, t, 0));

const NOW = Date.UTC(2026, 10, 10, 3); // Tue 12:00 JST, week of 2026-11-09
const VECTORS = join(import.meta.dirname, '../../contracts/race-advice.vectors.json');
const cat = catalogFor(m);
const en = (s: string) => translateText(s, cat);

function setup() {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(5), clock: () => now, verifiers: { fake: store } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
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
    activeRuleset: async () => DEFAULT_RULESET,
  };
  const get = async (user: string, path: string) => {
    const res = await handle(new Request(`https://x${path}`, { headers: { 'x-test-user': user } }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const give = async (uid: string, templateId: string) => {
    await svc.bootstrap(uid);
    const s = repo.get(uid)!;
    const h = createHorseFromTemplate(s, m.templateById.get(templateId)!, now);
    repo.put(s);
    return h.id;
  };
  return { svc, repo, store, c, get, give, setNow: (t: number) => { now = t; } };
}

describe('REQ-ADV-002 shared vectors (TS server = C# client)', () => {
  it('the committed vectors file is what the server computes (npm run gen:advice-vectors)', () => {
    expect(readFileSync(VECTORS, 'utf8')).toBe(adviceVectorsJson());
  });
  it('every vector input maps to its output', () => {
    const file = JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: { name: string; input: AdviceInput; output: AdviceOutput }[] };
    expect(file.cases.length).toBeGreaterThanOrEqual(12);
    for (const c of file.cases) expect(computeRaceAdvice(c.input), c.name).toEqual(c.output);
  });
  it('the vectors cover every mode the client sends and both a pool and a known course', () => {
    const file = JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: { input: AdviceInput; output: AdviceOutput }[] };
    const modes = new Set(file.cases.map((c) => c.input.mode));
    for (const mode of ['ranked', 'friend', 'event', 'challenge', 'timeattack', 'tutorial']) expect(modes.has(mode as never), mode).toBe(true);
    expect(file.cases.some((c) => c.input.courses.length > 1)).toBe(true);
    const reasons = new Set(file.cases.map((c) => c.output.suggestReason));
    for (const r of ['aptitude', 'stats', 'only', 'even', null]) expect(reasons.has(r as never), String(r)).toBe(true);
  });
});

describe('REQ-ADV-001/003 computed from data, never random', () => {
  const horses = INSTANCES.slice(0, 12).map((h) => adviceHorse(m, h));
  const base = (): AdviceInput => ({ v: 1, mode: 'friend', courses: [adviceCourse(m.tracks[0]!, 'good', false)], horses, field: null, rules: adviceRules(DEFAULT_RULESET), statCap: null, fixedStats: false, focusHorseId: null });
  it('the same input gives the same output, and the order of horses does not matter', () => {
    const a = computeRaceAdvice(base());
    expect(computeRaceAdvice(base())).toEqual(a);
    expect(computeRaceAdvice({ ...base(), horses: [...horses].reverse() })).toEqual(a);
  });
  it('the going specialist number is the engine\'s (RaceSim.GoingSpecialistPermille)', () => {
    expect(goingSpecialistPermille('heavy', 'soft', 8)).toBe(8);
    expect(goingSpecialistPermille('heavy', 'yielding', 8)).toBe(4);
    expect(goingSpecialistPermille('heavy', 'firm', 8)).toBe(-8);
    expect(goingSpecialistPermille('fast', 'sloppy', 8)).toBe(-8);
    expect(goingSpecialistPermille('fast', 'muddy', 8)).toBe(-4);
    expect(goingSpecialistPermille('fast', 'fast', 8)).toBe(8);
    expect(goingSpecialistPermille('any', 'soft', 8)).toBe(0);
    expect(goingSpecialistPermille('heavy', 'yielding', 7)).toBe(3); // truncation toward zero like C#
    expect(goingSpecialistPermille('fast', 'yielding', 7)).toBe(-3);
  });
  it('a horse outside its distance or surface ranks below one inside (the engine takes 5 % off speed and stamina)', () => {
    const out = computeRaceAdvice({ ...base(), courses: [adviceCourse(m.tracks.find((t) => t.id === 'aoba_dirt_1400')!, 'fast', false)] });
    const firstPoor = out.horses.findIndex((h) => h.grade === 'poor' && h.checks.some((c) => c.kind === 'surface' && c.mark === 'minus'));
    const lastOk = out.horses.map((h) => !h.checks.some((c) => (c.kind === 'surface' || c.kind === 'distance') && c.mark === 'minus')).lastIndexOf(true);
    expect(lastOk).toBeLessThan(firstPoor);
  });
  it('no line is a win probability or odds: suggestions are about fit, and ranks are an order not a forecast', () => {
    const out = computeRaceAdvice(base());
    expect(JSON.stringify(out)).not.toMatch(/prob|odds|chance|winRate/i);
  });
});

describe('REQ-ADV-004 honest wording: the lint over every generated line, in Japanese and English', () => {
  const rules = adviceRules(DEFAULT_RULESET);
  const all = INSTANCES.map((h) => adviceHorse(m, h));
  const texts = new Set<string>();
  for (const t of m.tracks) for (const g of goingsFor(t.surface)) for (const night of [false, true]) for (const mode of ADVICE_MODES) {
    for (let i = 0; i < all.length; i += 3) {
      const horses = all.slice(i, i + 3);
      const statCap = mode === 'ranked' || mode === 'challenge' ? 3200 : null;
      for (const field of [null, { nige: 0, senko: 1, sashi: 1, oikomi: 0, unknown: 0 }, { nige: 3, senko: 0, sashi: 0, oikomi: 0, unknown: 4 }]) {
        const a = computeRaceAdvice({ v: 1, mode, courses: [adviceCourse(t, g as Going, night)], horses, field, rules, statCap, fixedStats: mode === 'event' && i % 2 === 0, focusHorseId: horses[i % horses.length]?.id ?? null });
        for (const x of adviceTexts(a)) texts.add(x);
      }
    }
  }
  const pool = computeRaceAdvice({ v: 1, mode: 'ranked', courses: m.tracks.map((t) => adviceCourse(t, t.surface === 'dirt' ? 'fast' : 'good', false)), horses: all, field: null, rules, statCap: 3200, fixedStats: false, focusHorseId: null });
  for (const x of adviceTexts(pool)) texts.add(x);
  for (const x of adviceTexts(tutorialAdvice())) texts.add(x);
  const names = new Set(m.templates.map((t) => t.name));
  /** Lint a text with the horse names taken out (player-named horses are never linted or translated). */
  const strip = (s: string) => [...names].reduce((a, n) => a.split(n).join('〈馬〉'), s);

  it('covers a real spread of texts', () => { expect(texts.size).toBeGreaterThan(60); });
  it('no Japanese line uses a banned word (勝率・オッズ・本命・穴・%・買…)', () => {
    const bad = [...texts].flatMap((x) => adviceTextProblems(strip(x)));
    expect(bad).toEqual([]);
  });
  it('every line has English, and the English is clean too (no odds, chance, %, buy…)', () => {
    const missing: string[] = [];
    const bad: string[] = [];
    for (const x of texts) {
      const e = en(x);
      if (e === null || hasJapanese(strip(e).replace('〈馬〉', ''))) { missing.push(x); continue; }
      bad.push(...ADVICE_BANNED_EN.filter((re) => re.test(e)).map((re) => `${re.source}: ${e}`));
    }
    expect(missing).toEqual([]);
    expect(bad).toEqual([]);
  });
  it('the lint itself catches betting and purchase words', () => {
    for (const s of ['勝率40%', '本命はこの馬', 'オッズ2.5', '穴馬', 'この馬を買えば勝てる', 'ガチャで強い馬を', '◎', 'win rate 30', 'best odds', 'buy this horse', 'a sure win', 'favourite']) expect(adviceTextProblems(s).length, s).toBeGreaterThan(0);
    expect(ADVICE_BANNED_JA.length).toBeGreaterThan(20);
  });
});

describe('REQ-ADV-005..009 GET /v1/races/advice', () => {
  it('ranked: the course is drawn at the start, so the advice counts fitting courses over today\'s courses with today\'s going', async () => {
    const w = setup();
    await w.give('p', 't_akatsuki');
    await w.give('p', 't_sunaarashi');
    const r = await w.get('p', '/v1/races/advice');
    expect(r.status).toBe(200);
    expect(r.body.context).toBe('ranked');
    expect(r.body.courseCount).toBe(m.tracks.length);
    expect(r.body.whip).toBeNull();
    expect(r.body.field).toBeNull();
    // the partner + 2 horses, each with a count of courses that fit (not a chance)
    expect(r.body.horses.length).toBeGreaterThanOrEqual(2);
    for (const h of r.body.horses) expect(h.checks[0].text).toMatch(/^今日の\d+コースのうち\d+コースで/);
    expect(r.body.lines.some((l: { kind: string; text: string }) => l.kind === 'rules' && l.text.startsWith('能力は合計'))).toBe(true);
  });
  it('ranked never takes a field from the client (no information the player could not see)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.get('p', '/v1/races/advice?context=ranked&field=nige,nige');
    expect(r.body.field).toBeNull();
  });
  it('friend room with the host\'s course: the day\'s going for that course, the members\' styles, the selected horse\'s tips', async () => {
    const w = setup();
    const h = await w.give('p', 't_kohaku');
    const r = await w.get('p', `/v1/races/advice?context=friend&trackId=kirameki_turf_2000&going=soft&field=nige,sashi&horseId=${h}`);
    expect(r.status).toBe(200);
    expect(r.body.courseCount).toBe(1);
    expect(r.body.focusHorseId).toBe(h);
    expect(r.body.field).toEqual({ nige: 1, senko: 0, sashi: 1, oikomi: 0, unknown: 0, size: 3 });
    expect(r.body.whip).toEqual({ startRemainingM: 400, spurtM: 700, intervalTicks: 20, count: 6 });
    expect(r.body.lines.map((l: { text: string }) => l.text)).toContain('重の馬場：脚が減りやすい。手綱で脚をためる');
  });
  it('weekly challenge: the loan horse is a candidate, own horses only when their style meets the condition, CPUs unknown, skills off', async () => {
    const w = setup();
    await w.give('p', 't_kohaku'); // nige
    await w.give('p', 't_ginga'); // senko
    const r = await w.get('p', '/v1/races/advice?context=challenge&challengeId=wa_nige');
    if (r.status === 404) return; // the rotation week may not include wa_nige on this date
    expect(r.status).toBe(200);
    const ids = r.body.horses.map((h: { horseId: string }) => h.horseId);
    expect(ids.some((x: string) => x.startsWith('loan_'))).toBe(true);
    expect(r.body.horses.every((h: { checks: { kind: string; mark: string }[] }) => h.checks.filter((c) => c.kind === 'skill').every((c) => c.mark === 'off'))).toBe(true);
  });
  it('weekly challenge of this week by id (whatever the rotation is)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const view = await w.svc.wchView('p');
    if (!view.enabled) return;
    const ch = view.challenges[0]!;
    const r = await w.get('p', `/v1/races/advice?context=challenge&challengeId=${ch.id}`);
    expect(r.status).toBe(200);
    expect(r.body.field.unknown).toBe(ch.cpuCount);
    expect(r.body.field.size).toBe(ch.cpuCount + 1);
    expect(r.body.horses[0].horseId).toMatch(/^loan_|^h/);
    expect(r.body.horses.some((h: { horseId: string }) => h.horseId === `loan_${ch.loan!.templateId}`)).toBe(true);
    expect((await w.get('p', '/v1/races/advice?context=challenge&challengeId=nope')).status).toBe(404);
  });
  it('time attack: alone on the course, skills off, normalised', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.get('p', '/v1/races/advice?context=timeattack&trackId=bellmoor_turf_1200');
    expect(r.status).toBe(200);
    expect(r.body.field.size).toBe(1);
    expect(r.body.whip.spurtM).toBe(420);
    expect(r.body.lines.some((l: { kind: string; text: string }) => l.kind === 'style' && /番手/.test(l.text))).toBe(false);
    expect((await w.get('p', '/v1/races/advice?context=timeattack')).status).toBe(400);
  });
  it('tutorial: the fixed simple version (no horse ranking)', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.get('p', '/v1/races/advice?context=tutorial');
    expect(r.body).toMatchObject({ tutorial: true, horses: [], suggestedHorseId: null });
    expect(r.body.lines.map((l: { text: string }) => l.text)).toEqual(['合図が出たら、ムチ', 'ムチは間隔をあけて打つと伸びる']);
  });
  it('English (?lang=en): every line and check is translated; horse names stay as written', async () => {
    const w = setup();
    await w.give('p', 't_kohaku');
    const r = await w.get('p', '/v1/races/advice?context=friend&trackId=minato_turf_2400&going=soft&field=nige,nige&lang=en');
    const texts = [...r.body.lines.map((l: { text: string }) => l.text), ...r.body.horses.flatMap((h: { checks: { text: string }[] }) => h.checks.map((c) => c.text))];
    const names = r.body.horses.map((h: { name: string }) => h.name);
    for (const t of texts) expect(hasJapanese(names.reduce((a: string, n: string) => a.split(n).join(''), t)), t).toBe(false);
    expect(texts).toContain('Soft ground: stamina drains faster. Save it with the rein');
  });
  it('bad parameters are 400; unknown course 404 / config error; a going that does not match the surface is 400', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    expect((await w.get('p', '/v1/races/advice?context=bogus')).status).toBe(400);
    expect((await w.get('p', '/v1/races/advice?context=friend&trackId=kirameki_turf_2000&going=sloppy')).status).toBe(400);
    expect((await w.get('p', '/v1/races/advice?context=friend&trackId=kirameki_turf_2000&going=mud')).status).toBe(400);
    expect((await w.get('p', '/v1/races/advice?context=friend&field=nige,runner')).status).toBe(400);
    expect((await w.get('p', `/v1/races/advice?context=friend&field=${Array(12).fill('nige').join(',')}`)).status).toBe(400);
    expect((await w.get('p', '/v1/races/advice?context=event')).status).toBe(400);
    expect((await w.get('p', '/v1/races/advice?context=event&eventId=nope')).status).toBe(404);
    expect((await w.get('p', '/v1/races/advice?context=friend&trackId=nope')).status).toBeGreaterThanOrEqual(400);
  });
  it('night is only for lit venues, and is honest: it does not change the race', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const lit = [...m.litTracks][0]!;
    const unlit = m.tracks.find((t) => !m.litTracks.has(t.id))!.id;
    const a = await w.get('p', `/v1/races/advice?context=friend&trackId=${lit}&night=1`);
    expect(a.body.lines.some((l: { kind: string }) => l.kind === 'night')).toBe(true);
    const b = await w.get('p', `/v1/races/advice?context=friend&trackId=${unlit}&night=1`);
    expect(b.body.lines.some((l: { kind: string }) => l.kind === 'night')).toBe(false);
  });
  it('the event context uses the event\'s courses and entry styles', async () => {
    const w = setup();
    await w.give('p', 't_kohaku');
    const ev = m.events[0];
    if (!ev) return;
    const r = await w.get('p', `/v1/races/advice?context=event&eventId=${ev.id}`);
    expect(r.status).toBe(200);
    expect(r.body.courseCount).toBe(ev.trackIds.length);
    if (ev.entry.styles) for (const h of r.body.horses) expect(ev.entry.styles).toContain(w.repo.get('p')!.horses.find((x) => x.id === h.horseId)!.style);
  });
});

describe('REQ-ADV-006 ranked fairness: free, the same for everyone, read-only', () => {
  it('a payer and a non-payer with the same horses get exactly the same advice, and asking changes no state', async () => {
    const w = setup();
    await w.give('a', 't_akatsuki');
    await w.give('b', 't_akatsuki');
    await w.svc.purchase('b', 'fake', 'coins_s', w.store.issue({ transactionId: 'fake:X1', productId: 'coins_s', purchasedAt: NOW, priceYen: 160 })).catch(() => undefined);
    const before = JSON.stringify(w.repo.get('a'));
    const qa = await w.svc.raceAdvice('a', { context: 'friend', trackId: 'kirameki_turf_2000' });
    const qb = await w.svc.raceAdvice('b', { context: 'friend', trackId: 'kirameki_turf_2000' });
    const strip = (x: typeof qa) => JSON.stringify(x).replace(/"h\d+"/g, '"h"');
    expect(strip(qa)).toBe(strip(qb));
    expect(JSON.stringify(w.repo.get('a'))).toBe(before);
  });
  it('the advice reads the active ruleset: without the distance keys it says what the old balance said', async () => {
    const w = setup();
    await w.give('p', 't_aozora');
    const legacy = Object.fromEntries(Object.entries(DEFAULT_RULESET).filter(([k]) => !DISTANCE_RULESET_KEYS.includes(k))) as typeof DEFAULT_RULESET;
    const now = await w.svc.raceAdvice('p', { context: 'friend', trackId: 'bellmoor_turf_1200' }, DEFAULT_RULESET);
    const old = await w.svc.raceAdvice('p', { context: 'friend', trackId: 'bellmoor_turf_1200' }, legacy);
    expect(now.lines.map((l) => l.text)).toContain('この距離で脚質の有利不利はない');
    expect(old.lines.map((l) => l.text)).toContain('短い距離：前の馬が残りやすい');
    expect(old.whip!.spurtM).toBe(700); // nothing scales without the keys
    expect(now.whip!.spurtM).toBe(420);
  });
});

describe('REQ-ADV-011 KPI client events', () => {
  it('advice_view and advice_follow are accepted and mapped to columns', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [
      { name: 'advice_view', at: NOW, props: { context: 'challenge', horses: 3, suggested: true } },
      { name: 'advice_follow', at: NOW, props: { context: 'ranked', followed: false } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([
      { name: 'advice_view', s1: 'challenge', count: 3, value: 1 },
      { name: 'advice_follow', s1: 'ranked', value: 0 },
    ]);
    expect(() => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'advice_follow', at: NOW, props: { context: 'shop', followed: true } }] })).toThrow();
    expect(() => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0', events: [{ name: 'advice_view', at: NOW, props: { context: 'ranked', horses: 1, suggested: true, odds: 2 } }] })).toThrow();
  });
});

