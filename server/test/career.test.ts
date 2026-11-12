import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { CareerService } from '../src/race/career.js';
import {
  BASE_CAREER, CAREER_HARD_LIMITS, careerOf, careerProblems, careerTotals, type CareerMaster, type CareerResult,
} from '../src/domain/career.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { STAT_KEYS, type Master } from '../src/domain/master.js';
import type { ReplayLog, VerifierOutput } from '../src/domain/schemas.js';
import type { VerifierClient } from '../src/domain/verifier.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { endpointGroup, isExempt, RACE_GROUPS } from '../src/domain/maintenance.js';
import { classifyKey } from '../src/domain/dataExport.js';
import { untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { masterTexts } from '../src/i18n/validate.js';
import { worstYenPerCoin } from '../src/domain/invite.js';
import { careerSampleJson } from '../src/domain/careerSample.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Thursday 2026-11-05 12:00 JST
const T0 = Date.UTC(2026, 10, 5, 3);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CM = careerOf(m);
const [C1, C2] = CM.chapters as [CareerMaster['chapters'][0], CareerMaster['chapters'][0]];
const [R1, R2, R3] = C1.races as [CareerMaster['chapters'][0]['races'][0], CareerMaster['chapters'][0]['races'][0], CareerMaster['chapters'][0]['races'][0]];
const total = (h: Record<string, unknown>) => STAT_KEYS.reduce((a, k) => a + (h[k] as number), 0);
const withCareer = (c: CareerMaster) => ({ ...m, career: c }) as Master;

function setup(master: Master = m) {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: {}, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, repo, kpi, invoker, setNow: (t: number) => { now = t; }, now: () => now };
}
type W = ReturnType<typeof setup>;

async function giveHorse(w: W, uid: string, templateId = 't_partner') {
  await w.svc.bootstrap(uid);
  const s = w.repo.get(uid)!;
  const h = createHorseFromTemplate(s, m.templateById.get(templateId)!, w.now());
  w.repo.put(s);
  return h.id;
}

/** Fake verifier: the player's slot finishes at `place` (1-based) at `tick`; null = did not finish. */
class FakeVerifier implements VerifierClient {
  calls: ReplayLog[] = [];
  fail = false;
  constructor(public place: number | null = 1, public tick = 1800, public hash = HASH_A) {}
  async verify(log: ReplayLog): Promise<VerifierOutput> {
    this.calls.push(log);
    if (this.fail) throw new Error('verifier down');
    const me = log.config.entrants.findIndex((e) => e.kind === 'human');
    const others = log.config.entrants.map((e) => e.slot).filter((x) => x !== me);
    const order = this.place === null ? [...others, me] : [...others.slice(0, this.place - 1), me, ...others.slice(this.place - 1)];
    const finishTicks = order.map((slot, i) => (slot === me && this.place === null ? -1 : this.tick - 20 + i * 10));
    if (this.place !== null) finishTicks[this.place - 1] = this.tick;
    return { resultHash: this.hash, order, finishTicks, finishFracs: finishTicks.map((t) => (t < 0 ? -1 : 0)), checksums: {} };
  }
}

const service = (w: W, verifier: VerifierClient) => new CareerService({ player: () => w.invoker, verifier, ticketSecret: 'test-secret', clock: w.now });
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
/** n whip inputs of the player's slot from 40 ticks after the gate. */
const whips = (slot: number, n: number) => Array.from({ length: n }, (_, i) => [200 + i * 30, slot, 32]);

async function run(w: W, cs: CareerService, uid: string, raceId: string, horseId: string, inputsN = 0, hash = HASH_A, key: string | null = null): Promise<CareerResult> {
  const st = await cs.start(uid, raceId, horseId, key ?? `k:${raceId}:${Math.random()}`, 'ja');
  return cs.submit(uid, { sessionId: st.sessionId, token: st.token, inputs: whips(st.playerSlot, inputsN), resultHash: hash });
}

describe('master (REQ-CAREER-002/010/011)', () => {
  it('the shipped career.json is clean: 5 chapters, 3–5 races each, the partner fits every course, chapter caps ≤ the partner', () => {
    expect(careerProblems(m)).toEqual([]);
    expect(CM.chapters).toHaveLength(5);
    for (const ch of CM.chapters) expect(ch.races.length).toBeGreaterThanOrEqual(3);
    const partner = m.templateById.get('t_partner')!;
    for (const ch of CM.chapters) expect(ch.statCap).toBeLessThanOrEqual(total(partner.stats as unknown as Record<string, unknown>));
    // texts carry their own English: not in the master text scan (no locale-en.json entry needed)
    expect(masterTexts(m).filter((x) => x.path.startsWith('career'))).toEqual([]);
  });

  it('E20: lifetime grants inside the code ceilings; no paid coins, no tickets, no random items', () => {
    const t = careerTotals(CM);
    expect(t.freeCoins).toBeLessThanOrEqual(CAREER_HARD_LIMITS.lifetimeFreeCoins);
    expect(t.material).toBeLessThanOrEqual(CAREER_HARD_LIMITS.lifetimeMaterial);
    expect(Math.round(CAREER_HARD_LIMITS.freeCoinsPerGrant * worstYenPerCoin(m))).toBeLessThanOrEqual(200);
    expect(JSON.stringify(CM)).not.toMatch(/paidCoins|gacha_ticket|ticket_sr_plus|training_apple|"horse"/);
  });

  it('refuses a bad master: course, going, lights, partner fit, cap, style pool, objectives, rewards, wording, English', () => {
    const bad = structuredClone(BASE_CAREER);
    const r = bad.chapters[0]!.races;
    r[0]!.trackId = 'aoba_dirt_1400'; // the partner is a turf horse
    r[1]!.going = 'sloppy'; // a dirt going on turf
    r[1]!.night = true; // kirameki has no lights
    r[2]!.clear = { maxWhips: 3 }; // a clear must be a finishing place
    r[2]!.stars[0]!.objective = { maxPlace: 7 }; // 7 runners: only means finishing
    bad.chapters[0]!.statCap = 3400; // above the partner's 3320
    bad.chapters[1]!.races[0]!.cpuStyles = ['oikomi']; // 4 oikomi templates < 6 CPU + 1
    bad.chapters[1]!.races[2]!.story.before = { ja: '馬券の話はしない', en: 'Check the odds' };
    bad.chapters[2]!.races[0]!.title = { ja: '灯', en: '灯がともる' };
    bad.chapters[2]!.races[1]!.reward = {};
    const p = careerProblems(m, bad);
    for (const re of [/does not fit aoba_dirt_1400/, /sloppy is not a turf going/, /has no floodlights/, /clear: the clear objective is a finishing place/,
      /stars\[0\]\.maxPlace: must be smaller than the field/, /statCap: 3400 is above the partner/, /only 4 CPU horses of oikomi/,
      /betting word/, /title\.en contains Japanese/, /c3_closers\.reward: needs free coins or an item/]) {
      expect(p.some((x) => re.test(x)), String(re)).toBe(true);
    }
    // schema: unknown items, paid coins, a third optional objective
    const s2 = structuredClone(BASE_CAREER) as unknown as { chapters: { races: { reward: unknown; stars: unknown[] }[] }[] };
    s2.chapters[0]!.races[0]!.reward = { items: [{ itemId: 'gacha_ticket', qty: 1 }] };
    expect(careerProblems(m, s2).join()).toMatch(/reward\.items/);
    s2.chapters[0]!.races[0]!.reward = { items: [{ itemId: 'training_apple', qty: 1 }] }; // only the daily missions give it (03 調教)
    expect(careerProblems(m, s2).join()).toMatch(/reward\.items/);
    s2.chapters[0]!.races[0]!.reward = { freeCoins: 101 }; // > the per-grant ceiling (≈ ¥200)
    expect(careerProblems(m, s2).join()).toMatch(/reward\.freeCoins/);
    s2.chapters[0]!.races[0]!.reward = { paidCoins: 10 };
    expect(careerProblems(m, s2).join()).toMatch(/reward/);
    s2.chapters[0]!.races[0]!.reward = { items: [{ itemId: 'breeding_material', qty: 1 }] };
    s2.chapters[0]!.races[0]!.stars.push({ objective: { maxPlace: 1 } });
    expect(careerProblems(m, s2).join()).toMatch(/stars/);
    // lifetime ceiling (E20)
    const s3 = structuredClone(BASE_CAREER);
    for (const ch of s3.chapters) for (const race of ch.races) race.reward = { freeCoins: 30 };
    expect(careerProblems(m, s3).join()).toMatch(/free coins over the whole career, at most 300/);
  });
});

describe('view (REQ-CAREER-003/005)', () => {
  it('chapters and races with story, objectives (star 1 = the clear), rewards, my progress; only the first race is open', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const v = await w.svc.careerView('p');
    if (!v.enabled) throw new Error('disabled');
    expect(v.chapters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(v.totalRaces).toBe(17);
    expect(v.maxStars).toBe(51);
    expect(v.totalStars).toBe(0);
    expect(v.nextRaceId).toBe(R1.id);
    const r1 = v.chapters[0]!.races[0]!;
    expect(r1.title).toBe('デビュー戦');
    expect(r1.story.before).toBe(R1.story.before.ja);
    expect(r1.fieldSize).toBe(6);
    expect(r1.statCap).toBe(2800);
    expect(r1.objectives.map((o) => [o.star, o.labels.map((l) => l.text).join('・')])).toEqual([[1, '3着以内でゴール'], [2, '1着でゴール'], [3, '3着以内でゴール・ムチ3回以内']]);
    expect(r1.progress).toMatchObject({ unlocked: true, cleared: false, stars: [], attempts: 0, rewarded: { clear: false, star2: false, star3: false } });
    expect(v.chapters[0]!.races[1]!.progress.unlocked).toBe(false);
    expect(v.chapters[1]!.unlocked).toBe(false);
    expect(v.rules).toEqual({ skills: false, normalized: true, ranked: false, leaderboards: false, missions: false, energy: false, paidContinue: false, paidSkip: false, rewardOnce: true });
    // English story / titles come from the master's own English
    const en = await w.svc.careerView('p', 'en');
    if (!en.enabled) throw new Error('disabled');
    expect(en.chapters[0]!.title).toBe('The First Strike');
    expect(en.chapters[0]!.races[0]!.story.after).toBe(R1.story.after.en);
  });

  it('disabled → { enabled: false } and start answers NOT_FOUND', async () => {
    const off = withCareer({ ...BASE_CAREER, config: { ...BASE_CAREER.config, enabled: false } });
    const w = setup(off);
    const h = await giveHorse(w, 'p');
    expect(await w.svc.careerView('p')).toEqual({ enabled: false });
    expect(await code(w.svc.careerStart('p', R1.id, h))).toBe('NOT_FOUND');
  });
});

describe('start (REQ-CAREER-004/005/006)', () => {
  it('issues a challenge-mode config: CPU fill, the chapter cap on every entrant, no skills, the form off, keyed, KPI', async () => {
    const w = setup();
    const ssr = await giveHorse(w, 'p', 't_akatsuki'); // a bought SSR (3590)
    const r = await w.svc.careerStart('p', R1.id, ssr, 'c:1');
    expect(r.config.mode).toBe('challenge');
    expect(r.config.raceId).toBe(`car_${r.sessionId}`);
    expect(r.config.entrants).toHaveLength(R1.cpuCount + 1);
    expect(r.config.entrants.filter((e) => e.kind === 'cpu').every((e) => e.cpuLevel === R1.cpuLevel)).toBe(true);
    expect(String(r.config.ruleset.rulesetVersion)).toMatch(/\+ta$/);
    const me = r.config.entrants[r.playerSlot]!;
    expect(me.kind).toBe('human');
    expect(me.playerId).toBe('p');
    expect(total(me.horse as unknown as Record<string, unknown>)).toBeLessThanOrEqual(C1.statCap); // paying cannot trivialise it
    for (const e of r.config.entrants) { expect(e.horse.skill).toBeUndefined(); expect(total(e.horse as unknown as Record<string, unknown>)).toBeLessThanOrEqual(C1.statCap); }
    expect(r.conditions).toEqual(R1.clear);
    const again = await w.svc.careerStart('p', R1.id, ssr, 'c:1');
    expect(again.sessionId).toBe(r.sessionId);
    expect(w.kpi.filter((k) => k.name === 'career_start').map((k) => [k.s1, k.s2, k.count])).toEqual([[R1.id, 'c1', 1]]);
  });

  it('the free partner reaches the chapter cap exactly as well as a bought horse does', async () => {
    const w = setup();
    const partner = await giveHorse(w, 'p', 't_partner');
    const ssr = await giveHorse(w, 'p', 't_ginga');
    const a = await w.svc.careerStart('p', R1.id, partner);
    const b = await w.svc.careerStart('p', R1.id, ssr);
    const ta = total(a.config.entrants[a.playerSlot]!.horse as unknown as Record<string, unknown>);
    const tb = total(b.config.entrants[b.playerSlot]!.horse as unknown as Record<string, unknown>);
    expect(ta).toBeGreaterThanOrEqual(C1.statCap - 5); // floor rounding of the normalisation
    expect(tb).toBeLessThanOrEqual(C1.statCap);
    expect(Math.abs(ta - tb)).toBeLessThanOrEqual(5);
  });

  it('ground, night and the CPU style filter come from the race; the same seed draws the same field', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const s = w.repo.get('p')!;
    // open the whole career to start any race
    s.career = { races: Object.fromEntries(CM.chapters.flatMap((c) => c.races).map((r) => [r.id, { attempts: 0, clearedAt: T0, stars: [1], bestPlace: 1, bestTimeMs: 1, granted: ['clear'] }])), sessions: [], daily: { date: '', count: 0 } };
    w.repo.put(s);
    const fr = CM.chapters[1]!.races[1]!; // 前が速い: nige / senko CPUs, soft
    const r = await w.svc.careerStart('p', fr.id, h);
    expect(r.config.track.going).toBe('soft');
    expect(r.config.entrants.filter((e) => e.kind === 'cpu').every((e) => ['nige', 'senko'].includes(e.horse.style))).toBe(true);
    const night = CM.chapters[2]!.races[0]!;
    const n = await w.svc.careerStart('p', night.id, h);
    expect(n.config.track.night).toBe(true);
  });

  it('refuses a locked race, an unknown race, a retired horse, a deleting account; the anti-abuse day count resets at the rollover', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    expect(await code(w.svc.careerStart('p', R2.id, h))).toBe('CAREER_LOCKED');
    expect(await code(w.svc.careerStart('p', C2.races[0]!.id, h))).toBe('CAREER_LOCKED');
    expect(await code(w.svc.careerStart('p', 'nope_race', h))).toBe('NOT_FOUND');
    const s = w.repo.get('p')!;
    s.horses.find((x) => x.id === h)!.status = 'retired';
    w.repo.put(s);
    expect(await code(w.svc.careerStart('p', R1.id, h))).toBe('HORSE_NOT_ACTIVE');
    const small = withCareer({ ...BASE_CAREER, config: { ...BASE_CAREER.config, startsPerDay: 20 } });
    const w2 = setup(small);
    const D = Date.UTC(2026, 11, 10, 3); // Thursday 2026-12-10 12:00 JST (after the 04:00 rollover switch)
    w2.setNow(D);
    const h2 = await giveHorse(w2, 'q');
    for (let i = 0; i < 20; i++) await w2.svc.careerStart('q', R1.id, h2);
    expect(await code(w2.svc.careerStart('q', R1.id, h2))).toBe('CAREER_LIMIT_REACHED');
    w2.setNow(Date.UTC(2026, 11, 10, 18, 59)); // 03:59 JST: the same game day
    expect(await code(w2.svc.careerStart('q', R1.id, h2))).toBe('CAREER_LIMIT_REACHED');
    w2.setNow(Date.UTC(2026, 11, 10, 19, 0)); // 04:00 JST: the next game day
    expect(await code(w2.svc.careerStart('q', R1.id, h2))).toBe('ok');
    const d = w2.repo.get('q')!;
    d.deletion = { status: 'deleting', steps: [] } as never;
    w2.repo.put(d);
    expect(await code(w2.svc.careerStart('q', R1.id, h2))).toBe('DELETION_PENDING');
  });
});

describe('submit → verifier → objectives on the server (REQ-CAREER-007/008/009)', () => {
  it('a first clear pays once, opens the next race; stars accumulate across runs and each pays once ever', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const v3 = new FakeVerifier(3);
    const cs = service(w, v3);
    const mat0 = w.repo.get('p')!.items['breeding_material'] ?? 0;
    // 3rd with 4 whips: star 1 only (clear), no star 3 (needs ≤ 3 whips)
    const a = await run(w, cs, 'p', R1.id, h, 4);
    expect(a.cleared).toBe(true);
    expect(a.firstClear).toBe(true);
    expect(a.stars).toEqual([1]);
    expect(a.rewards).toEqual([{ kind: 'clear', reward: R1.reward }]);
    expect(a.unlockedRaceId).toBe(R2.id);
    expect(a.chapterCleared).toBe(false);
    expect(w.repo.get('p')!.items['breeding_material']).toBe(mat0 + 1);
    expect(v3.calls[0]!.config.raceId).toMatch(/^car_/);
    // again 3rd with 2 whips: star 3 (3rd & ≤ 3 whips) — the clear does not pay again
    const b = await run(w, cs, 'p', R1.id, h, 2);
    expect(b.firstClear).toBe(false);
    expect(b.newStars).toEqual([3]);
    expect(b.stars).toEqual([1, 3]);
    expect(b.rewards).toEqual([{ kind: 'star3', reward: R1.stars[1]!.reward }]);
    // a win: star 2
    v3.place = 1;
    const c = await run(w, cs, 'p', R1.id, h, 0);
    expect(c.newStars).toEqual([2]);
    expect(c.rewards.map((g) => g.kind)).toEqual(['star2']);
    // a fourth run with everything: nothing new, nothing paid
    const d = await run(w, cs, 'p', R1.id, h, 0);
    expect(d.newStars).toEqual([]);
    expect(d.rewards).toEqual([]);
    const v = await w.svc.careerView('p');
    if (!v.enabled) throw new Error('disabled');
    expect(v.chapters[0]!.races[0]!.progress).toMatchObject({ cleared: true, stars: [1, 2, 3], attempts: 4, bestPlace: 1, rewarded: { clear: true, star2: true, star3: true } });
    expect(v.chapters[0]!.races[1]!.progress.unlocked).toBe(true);
    expect(v.nextRaceId).toBe(R2.id);
    expect(w.repo.get('p')!.items['training_apple'] ?? 0).toBe(0); // never the daily missions' apple
    // KPI
    expect(w.kpi.filter((k) => k.name === 'career_clear').map((k) => [k.s1, k.isFirst, k.place])).toEqual([[R1.id, true, 3], [R1.id, false, 3], [R1.id, false, 1], [R1.id, false, 1]]);
    expect(w.kpi.filter((k) => k.name === 'career_star').map((k) => k.value)).toEqual([1, 3, 2]);
  });

  it('a fail (place / not finishing) records the attempt, pays nothing and opens nothing', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const cs = service(w, new FakeVerifier(5));
    const a = await run(w, cs, 'p', R1.id, h);
    expect(a.cleared).toBe(false);
    expect(a.stars).toEqual([]);
    expect(a.rewards).toEqual([]);
    expect(a.unlockedRaceId).toBeNull();
    const dnf = await run(w, service(w, new FakeVerifier(null)), 'p', R1.id, h);
    expect(dnf.evaluation.finished).toBe(false);
    expect(await code(w.svc.careerStart('p', R2.id, h))).toBe('CAREER_LOCKED');
    expect(w.kpi.filter((k) => k.name === 'career_clear')).toEqual([]);
  });

  it('a star needs the clear in the same run (a whip-light 5th place earns nothing)', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const a = await run(w, service(w, new FakeVerifier(4)), 'p', R1.id, h, 0);
    expect(a.objectives.map((o) => o.ok)).toEqual([false, false, false]);
  });

  it('double submit / replay of the same run cannot pay twice; a second session clearing again pays nothing', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const fv = new FakeVerifier(1);
    const cs = service(w, fv);
    const st = await cs.start('p', R1.id, h, 'k1', 'ja');
    const body = { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A };
    const [x, y] = await Promise.all([cs.submit('p', body), cs.submit('p', body).catch((e) => e as AppError)]);
    const first = 'rewards' in x ? x : (y as CareerResult);
    expect(first.rewards.map((g) => g.kind).sort()).toEqual(['clear', 'star2', 'star3']);
    const replay = await cs.submit('p', body);
    expect(replay).toEqual(first); // the stored result, nothing granted again
    expect(fv.calls.length).toBeLessThanOrEqual(2);
    const mat = w.repo.get('p')!.items['breeding_material'];
    const again = await run(w, cs, 'p', R1.id, h);
    expect(again.rewards).toEqual([]);
    expect(w.repo.get('p')!.items['breeding_material']).toBe(mat);
    // a different hash on the verified session is a used session
    expect(await code(cs.submit('p', { ...body, resultHash: HASH_B }))).toBe('CAREER_SESSION_USED');
  });

  it('a hash mismatch is rejected and recorded; a forged token / another player / an expired session are refused', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const cs = service(w, new FakeVerifier(1, 1800, HASH_B));
    const st = await cs.start('p', R1.id, h, 'k1', 'ja');
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('CAREER_RESULT_MISMATCH');
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('CAREER_SESSION_USED');
    expect(w.repo.get('p')!.career!.races[R1.id]!.clearedAt).toBeNull();
    const st2 = await cs.start('p', R1.id, h, 'k2', 'ja');
    expect(await code(cs.submit('p', { sessionId: st2.sessionId, token: 'x.y', inputs: [], resultHash: HASH_B }))).toBe('CAREER_SESSION_EXPIRED');
    expect(await code(cs.submit('q', { sessionId: st2.sessionId, token: st2.token, inputs: [], resultHash: HASH_B }))).toBe('UNAUTHORIZED');
    w.setNow(T0 + BASE_CAREER.config.sessionTtlMs + 1);
    expect(await code(cs.submit('p', { sessionId: st2.sessionId, token: st2.token, inputs: [], resultHash: HASH_B }))).toBe('CAREER_SESSION_EXPIRED');
  });

  it('inputs: only the player slot, client bits, increasing ticks; the verifier down keeps the session open for a retry', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const fv = new FakeVerifier(1);
    const cs = service(w, fv);
    const st = await cs.start('p', R1.id, h, 'k1', 'ja');
    const other = (st.playerSlot + 1) % 6;
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[100, other, 1]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[100, st.playerSlot, 64]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[100, st.playerSlot, 1], [100, st.playerSlot, 32]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    fv.fail = true;
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('VERIFIER_UNAVAILABLE');
    fv.fail = false;
    const r = await cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A });
    expect(r.cleared).toBe(true);
    // the config echoed back must be the issued one
    const st2 = await cs.start('p', R1.id, h, 'k2', 'ja');
    expect(await code(cs.submit('p', { sessionId: st2.sessionId, token: st2.token, inputs: [], resultHash: HASH_A, config: { ...st2.config, seed: '1' } }))).toBe('TA_CONFIG_MISMATCH');
  });

  it('the session snapshot wins over a master edited mid-race (objectives and rewards shown at the start)', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const cs = service(w, new FakeVerifier(3));
    const st = await cs.start('p', R1.id, h, 'k1', 'ja');
    const s = w.repo.get('p')!;
    s.career!.sessions[0]!.snapshot.clear = { maxPlace: 3 };
    w.repo.put(s);
    const edited = structuredClone(BASE_CAREER);
    edited.chapters[0]!.races[0]!.clear = { maxPlace: 1 };
    (w.svc as unknown as { d: { master: Master } }).d.master = withCareer(edited);
    const r = await cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A });
    expect(r.cleared).toBe(true);
  });

  it('clearing a chapter\'s last race reports the chapter and opens the next chapter', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const cs = service(w, new FakeVerifier(1));
    await run(w, cs, 'p', R1.id, h);
    await run(w, cs, 'p', R2.id, h);
    const last = await run(w, cs, 'p', R3.id, h);
    expect(last.chapterCleared).toBe(true);
    expect(last.unlockedRaceId).toBe(C2.races[0]!.id);
    expect(w.kpi.filter((k) => k.name === 'career_clear' && k.value === 1).map((k) => k.s1)).toEqual([R3.id]);
    const v = await w.svc.careerView('p');
    if (!v.enabled) throw new Error('disabled');
    expect(v.chapters[0]!.cleared).toBe(true);
    expect(v.chapters[1]!.unlocked).toBe(true);
    expect(v.totalStars).toBe(9);
  });

  it('never touches rating, class / season points, stats, missions, pass XP, leaderboards, paid coins', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const before = structuredClone(w.repo.get('p')!);
    const cs = service(w, new FakeVerifier(1));
    await run(w, cs, 'p', R1.id, h);
    const after = w.repo.get('p')!;
    for (const k of ['rating', 'season', 'stats', 'missions', 'seasonPass', 'seasonMissions', 'appliedRaces', 'timeAttack', 'weeklyChallenge', 'dailyWins'] as const) {
      expect(after[k as keyof typeof after], k).toEqual(before[k as keyof typeof before]);
    }
    expect(after.wallet.paid).toBe(before.wallet.paid);
    expect(after.wallet.free).toBe(before.wallet.free); // the shipped career pays items only (E20)
  });

  it('a tombstoned (wiped) account is never re-created by a career call', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p');
    const cs = service(w, new FakeVerifier(1));
    const st = await cs.start('p', R1.id, h, 'k1', 'ja');
    await w.svc.wipe('p');
    expect(await code(cs.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('NOT_FOUND');
    expect(await code(w.svc.careerStart('p', R1.id, h))).toBe('NOT_FOUND');
    expect(w.repo.get('p')).toBeFalsy();
  });
});

describe('integration: KPI consent, maintenance, data export, HTTP and English (REQ-CAREER-012..016)', () => {
  it('contracts/career-configs.sample.json is what the server issues (npm run gen:career-sample)', () => {
    expect(readFileSync(join(import.meta.dirname, '../../contracts/career-configs.sample.json'), 'utf8')).toBe(careerSampleJson(m));
  });

  it('KPI events are optional analytics; routes are in the time_attack race group, the submit is exempt; the state key is play data', () => {
    for (const n of ['career_start', 'career_clear', 'career_star']) expect(kpiClassOf(n)).toBe('optional');
    expect(endpointGroup('/v1/career')).toBe('time_attack');
    expect(endpointGroup('/v1/career/races/c1_debut/start')).toBe('time_attack');
    expect(RACE_GROUPS).toContain('time_attack');
    expect(isExempt('POST', '/v1/career/submit')).toBe(true);
    expect(isExempt('POST', '/v1/career/races/c1_debut/start')).toBe(false);
    expect(classifyKey('career')).toEqual({ section: 'play' });
  });

  it('GET / start (keyed) / submit; strict bodies; every text in English with ?lang=en', async () => {
    const w = setup();
    const h = await giveHorse(w, 'p1');
    const cs = service(w, new FakeVerifier(1));
    const ctx = { master: m, authenticate: async (r: Request) => r.headers.get('x-test-user') ?? '', player: () => w.invoker, career: cs, clock: w.now } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': 'p1', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, ctx);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const v = await call('GET', '/v1/career');
    expect(v.status).toBe(200);
    expect(v.json.nextRaceId).toBe(R1.id);
    expect((await call('POST', `/v1/career/races/${R1.id}/start`, { horseId: h })).status).toBe(400); // idempotency key required
    expect((await call('POST', `/v1/career/races/${R1.id}/start`, { horseId: h, extra: 1 }, { 'idempotency-key': 'k0' })).status).toBe(400);
    expect((await call('POST', `/v1/career/races/${R2.id}/start`, { horseId: h }, { 'idempotency-key': 'k0' })).status).toBe(409);
    const st = await call('POST', `/v1/career/races/${R1.id}/start?lang=en`, { horseId: h }, { 'idempotency-key': 'k1' });
    expect(st.status).toBe(200);
    expect(untranslated(st.json.race, PLAYER_TEXT_KEYS)).toEqual([]);
    const st2 = await call('POST', `/v1/career/races/${R1.id}/start`, { horseId: h }, { 'idempotency-key': 'k1' });
    expect(st2.json.sessionId).toBe(st.json.sessionId);
    const sub = await call('POST', '/v1/career/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A });
    expect(sub.status).toBe(200);
    expect(sub.json.cleared).toBe(true);
    expect((await call('POST', '/v1/career/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A, extra: 1 })).status).toBe(400);
    const en = await call('GET', '/v1/career?lang=en');
    expect(untranslated(en.json, PLAYER_TEXT_KEYS)).toEqual([]);
    const enSub = await call('POST', '/v1/career/submit?lang=en', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A });
    expect(untranslated(enSub.json, PLAYER_TEXT_KEYS)).toEqual([]);
    const none = await handle(new Request('https://x/v1/career', { headers: { 'x-test-user': 'p1' } }), {}, { ...ctx, career: undefined } as AppContext);
    expect(none.status).toBe(404);
  });
});
