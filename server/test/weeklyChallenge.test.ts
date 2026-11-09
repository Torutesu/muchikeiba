import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { WeeklyChallengeService } from '../src/race/weeklyChallenge.js';
import {
  conditionLabels, evaluateChallenge, formatRaceTime, loanRaceHorse, weekAt, weeklyChallengeConfig, weeklyChallengeProblems, WCH_HARD_LIMITS,
  type ChallengeDef, type WchResult, type WeeklyChallengeConfig,
} from '../src/domain/weeklyChallenge.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { raceTimeMs } from '../src/domain/timeAttack.js';
import { gameWeekEndMs, gameWeekId, gameWeekStartMs, DEFAULT_DAY_ROLLOVER } from '../src/domain/time.js';
import { STAT_KEYS, type Master } from '../src/domain/master.js';
import type { RaceStartConfig, ReplayLog, VerifierOutput } from '../src/domain/schemas.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifierClient } from '../src/domain/verifier.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { catalogFor, localize, untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { worstYenPerCoin } from '../src/domain/invite.js';

// Thursday 2026-11-05 12:00 JST: the week of Monday 2026-11-02 = the anchor week (rotation[0] w_aoba)
const T0 = Date.UTC(2026, 10, 5, 3);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const cfg = weeklyChallengeConfig(m)!;
const WEEK0 = cfg.rotation[0]!;
const [NIGE, WHIP3, RAIN] = WEEK0.challenges as [ChallengeDef, ChallengeDef, ChallengeDef];

function setup(master: Master = m) {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: {}, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, repo, kpi, invoker, setNow: (t: number) => { now = t; }, now: () => now };
}

/** Gives the player an active horse of a template (seeded through the repository, like a scout result). */
async function giveHorse(w: ReturnType<typeof setup>, uid: string, templateId: string) {
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

function service(w: ReturnType<typeof setup>, verifier: VerifierClient) {
  return new WeeklyChallengeService({ player: () => w.invoker, verifier, ticketSecret: 'test-secret', clock: w.now });
}

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('the game week (REQ-WCH-001)', () => {
  it('starts on Monday at the game-day rollover (04:00 JST after the shipped switch) and is shared via time.ts', () => {
    const rule = DEFAULT_DAY_ROLLOVER;
    // before the switch (midnight rollover): Thursday 2026-11-05 is in the week of 11-02
    expect(gameWeekId(T0, rule)).toBe('2026-11-02');
    // after the switch: Monday 2026-12-07 03:59 JST still belongs to the week of 11-30; 04:00 JST starts 12-07
    expect(gameWeekId(Date.UTC(2026, 11, 6, 18, 59), rule)).toBe('2026-11-30');
    expect(gameWeekId(Date.UTC(2026, 11, 6, 19, 0), rule)).toBe('2026-12-07');
    expect(gameWeekStartMs('2026-12-07', rule)).toBe(Date.UTC(2026, 11, 6, 19, 0));
    expect(gameWeekEndMs('2026-12-07', rule)).toBe(Date.UTC(2026, 11, 13, 19, 0));
    // another start day (Sunday)
    expect(gameWeekId(T0, rule, 0)).toBe('2026-11-01');
  });

  it('rotates through the table one week at a time from the anchor week (and backwards)', () => {
    expect(weekAt(m, cfg, T0).def.id).toBe('w_aoba');
    expect(weekAt(m, cfg, T0, 1).def.id).toBe('w_minato');
    expect(weekAt(m, cfg, T0, 2).def.id).toBe('w_bellmoor');
    expect(weekAt(m, cfg, T0, 3).def.id).toBe('w_aoba');
    expect(weekAt(m, cfg, T0, -1).def.id).toBe('w_bellmoor');
  });
});

describe('view (REQ-WCH-002/004)', () => {
  it("this week's 3 challenges with conditions, loan horse, reward, my progress, the badge and next week's preview", async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const v = await w.svc.wchView('p');
    if (!v.enabled) throw new Error('disabled');
    expect(v.weekId).toBe('2026-11-02');
    expect(v.endsAt).toBe(gameWeekEndMs('2026-11-02', DEFAULT_DAY_ROLLOVER));
    expect(v.challenges.map((c) => c.id)).toEqual([NIGE.id, WHIP3.id, RAIN.id]);
    const nige = v.challenges[0]!;
    expect(nige.labels.map((l) => l.text)).toEqual(['逃げの馬で出走', '1着でゴール']);
    expect(nige.loan).toEqual({ templateId: NIGE.loanTemplateId, name: m.templateById.get(NIGE.loanTemplateId)!.name, style: 'nige', statTotal: 3200 });
    expect(nige.progress).toEqual({ cleared: false, clearedAt: null, attempts: 0, bestPlace: null, bestTimeMs: null });
    expect(v.challenges[2]!.going).toBe('soft');
    expect(v.challenges[2]!.labels[0]!.text).toBe(`${formatRaceTime(RAIN.conditions.maxTimeMs!)}以内で完走`);
    expect(v.badge).toEqual({ id: WEEK0.badge.id, name: WEEK0.badge.name, earned: false, earnedAt: null });
    expect(v.next!.weekId).toBe('2026-11-09');
    expect(v.next!.challenges).toHaveLength(3);
    expect((v.next!.challenges[0] as Record<string, unknown>).progress).toBeUndefined();
    expect(v.startsLeftToday).toBe(cfg.startsPerDay);
    expect(v.rules).toEqual({ statCap: 3200, normalized: true, skills: false, loanAtCap: true, paidBoosts: false, rewardOncePerWeek: true });
  });

  it('disabled (or absent) → { enabled: false } and the actions answer NOT_FOUND', async () => {
    const off = { ...m, progression: { ...m.progression, weeklyChallenge: { ...cfg, enabled: false } } } as Master;
    const w = setup(off);
    expect(await w.svc.wchView('p')).toEqual({ enabled: false });
    expect(await code(w.svc.wchStart('p', NIGE.id, { loan: true }))).toBe('NOT_FOUND');
  });

  it('condition labels: one line each; a time-only challenge adds no extra finish line', () => {
    expect(conditionLabels({ maxWhips: 0, maxPlace: 5 }).map((l) => l.text)).toEqual(['5着以内でゴール', 'ムチを使わない']);
    expect(conditionLabels({ maxWhips: 3 }).map((l) => l.text)).toEqual(['ムチ3回以内', '完走する']);
    expect(formatRaceTime(72_345)).toBe('1:12.3');
  });
});

describe('start (REQ-WCH-003/007)', () => {
  it('issues a challenge config: normalised to the cap, no skills, the form off, fixed ground; the loan horse is at the cap', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const r = await w.svc.wchStart('p', RAIN.id, { loan: true }, 'c:s1');
    expect(r.config.mode).toBe('challenge');
    expect(r.config.track.going).toBe('soft');
    expect(r.config.entrants).toHaveLength(RAIN.cpuCount + 1);
    expect(String(r.config.ruleset.rulesetVersion)).toMatch(/\+ta$/);
    const me = r.config.entrants[r.playerSlot]!;
    expect(me.kind).toBe('human');
    expect(me.horse.id).toBe(`loan_${RAIN.loanTemplateId}`);
    expect(STAT_KEYS.reduce((a, k) => a + me.horse[k], 0)).toBe(cfg.statCap);
    for (const e of r.config.entrants) {
      expect(e.horse.skill).toBeUndefined();
      expect(STAT_KEYS.reduce((a, k) => a + e.horse[k], 0)).toBeLessThanOrEqual(cfg.statCap);
    }
    // keyed: a retried start returns the same session and uses no second start
    const again = await w.svc.wchStart('p', RAIN.id, { loan: true }, 'c:s1');
    expect(again.sessionId).toBe(r.sessionId);
    expect(again.startsLeftToday).toBe(cfg.startsPerDay - 1);
    // KPI challenge_start once
    expect(w.kpi.filter((k) => k.name === 'challenge_start').map((k) => [k.s1, k.s2, k.s3])).toEqual([[RAIN.id, '2026-11-02', 'loan']]);
  });

  it('a style constraint refuses another style; the loan horse always qualifies; a strong own horse is still normalised', async () => {
    const w = setup();
    const sashi = await giveHorse(w, 'p', 't_akatsuki'); // SSR sashi (3590)
    const nige = await giveHorse(w, 'p', 't_kohaku'); // SSR nige (3460)
    expect(await code(w.svc.wchStart('p', NIGE.id, { horseId: sashi }))).toBe('CHALLENGE_HORSE_INELIGIBLE');
    const own = await w.svc.wchStart('p', NIGE.id, { horseId: nige });
    const ownTotal = STAT_KEYS.reduce((a, k) => a + own.config.entrants[own.playerSlot]!.horse[k], 0);
    const loan = await w.svc.wchStart('p', NIGE.id, { loan: true });
    const loanTotal = STAT_KEYS.reduce((a, k) => a + loan.config.entrants[loan.playerSlot]!.horse[k], 0);
    // the purchasable SSR is capped; the free loan horse is lifted to exactly the cap: never weaker in stat total
    expect(ownTotal).toBeLessThanOrEqual(cfg.statCap);
    expect(loanTotal).toBe(cfg.statCap);
    expect(loanTotal).toBeGreaterThanOrEqual(ownTotal);
    expect(own.config.entrants[own.playerSlot]!.horse.skill).toBeUndefined();
  });

  it('refuses another week\'s challenge, both or neither horse choice, a daily start cap, and a deleting account', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    expect(await code(w.svc.wchStart('p', cfg.rotation[1]!.challenges[0]!.id, { loan: true }))).toBe('NOT_FOUND');
    expect(await code(w.svc.wchStart('p', NIGE.id, {}))).toBe('BAD_REQUEST');
    expect(await code(w.svc.wchStart('p', NIGE.id, { loan: true, horseId: 'h1' }))).toBe('BAD_REQUEST');
    const small = { ...m, progression: { ...m.progression, weeklyChallenge: { ...cfg, startsPerDay: 2 } } } as Master;
    const w2 = setup(small);
    await w2.svc.bootstrap('q');
    await w2.svc.wchStart('q', NIGE.id, { loan: true });
    await w2.svc.wchStart('q', NIGE.id, { loan: true });
    expect(await code(w2.svc.wchStart('q', NIGE.id, { loan: true }))).toBe('CHALLENGE_LIMIT_REACHED');
    w2.setNow(T0 + 24 * 3600_000); // the next game day
    expect(await code(w2.svc.wchStart('q', NIGE.id, { loan: true }))).toBe('ok');
    const s = w.repo.get('p')!;
    s.deletion = { status: 'deleting', steps: [] } as never;
    w.repo.put(s);
    expect(await code(w.svc.wchStart('p', NIGE.id, { loan: true }))).toBe('DELETION_PENDING');
  });
});

describe('submit → verifier → evaluation on the server (REQ-WCH-005/006/008)', () => {
  it('a clear is evaluated from the verified result, pays its reward once per week; a repeat clear pays nothing', async () => {
    // a table that pays free coins too (the shipped one pays breeding material only, E18): coins + material, once a week
    const coinCfg = structuredClone(cfg);
    coinCfg.rotation[0]!.challenges[0]!.reward = { freeCoins: 10, items: [{ itemId: 'breeding_material', qty: 1 }] };
    expect(weeklyChallengeProblems({ ...m, progression: { ...m.progression, weeklyChallenge: coinCfg } } as Master)).toEqual([]);
    const NIGE = coinCfg.rotation[0]!.challenges[0]!;
    const w = setup({ ...m, progression: { ...m.progression, weeklyChallenge: coinCfg } } as Master);
    await w.svc.bootstrap('p');
    const ver = new FakeVerifier(1);
    const svc = service(w, ver);
    const free0 = w.repo.get('p')!.wallet.free;
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:k1');
    const inputs = [[60, st.playerSlot, 1]];
    const r = await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs, resultHash: HASH_A });
    expect(ver.calls).toHaveLength(1);
    expect(ver.calls[0]!.config).toEqual(st.config); // the issued config, never the client's
    expect(r.cleared).toBe(true);
    expect(r.firstClear).toBe(true);
    expect(r.reward).toEqual(NIGE.reward);
    expect(r.evaluation.place).toBe(1);
    expect(r.evaluation.timeMs).toBe(raceTimeMs(st.config, 1800, 0));
    expect(r.evaluation.checks.map((c) => [c.kind, c.ok])).toEqual([['finish', true], ['place', true], ['style', true]]);
    expect(w.repo.get('p')!.wallet.free).toBe(free0 + NIGE.reward.freeCoins!);
    // idempotent: the same submit again returns the stored result and grants nothing
    const again = await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs, resultHash: HASH_A });
    expect(again).toEqual(r);
    expect(ver.calls).toHaveLength(1);
    // another clear of the same challenge this week: verified, cleared, but no second reward
    const st2 = await svc.start('p', NIGE.id, { loan: true }, 'c:k2');
    const r2 = await svc.submit('p', { sessionId: st2.sessionId, token: st2.token, inputs: [], resultHash: HASH_A });
    expect(r2.cleared).toBe(true);
    expect(r2.firstClear).toBe(false);
    expect(r2.reward).toBeNull();
    expect(w.repo.get('p')!.wallet.free).toBe(free0 + NIGE.reward.freeCoins!);
    expect(w.repo.get('p')!.wallet.paid).toBe(0);
    const v = await w.svc.wchView('p');
    if (!v.enabled) throw new Error();
    expect(v.challenges[0]!.progress.cleared).toBe(true);
    expect(v.challenges[0]!.progress.attempts).toBe(2);
    expect(v.clearedCount).toBe(1);
    // KPI: a clear row per verified clear, isFirst on the first
    expect(w.kpi.filter((k) => k.name === 'challenge_clear').map((k) => [k.s1, k.isFirst, k.place, k.freeCoins])).toEqual([[NIGE.id, true, 1, 10], [NIGE.id, false, 1, 0]]);
  });

  it('the whip condition counts the submitted (verified) whip inputs; 4 whips fail a 3-whip challenge', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const svc = service(w, new FakeVerifier(2));
    const whip = (st: { playerSlot: number }, n: number) => [[60, st.playerSlot, 1], ...Array.from({ length: n }, (_, i) => [800 + i * 30, st.playerSlot, 32])];
    const a = await svc.start('p', WHIP3.id, { loan: true }, 'c:a');
    const fail = await svc.submit('p', { sessionId: a.sessionId, token: a.token, inputs: whip(a, 4), resultHash: HASH_A });
    expect(fail.cleared).toBe(false);
    expect(fail.evaluation.whips).toBe(4);
    expect(fail.evaluation.checks.find((c) => c.kind === 'whips')).toEqual({ kind: 'whips', target: 3, actual: 4, ok: false });
    expect(fail.reward).toBeNull();
    const b = await svc.start('p', WHIP3.id, { loan: true }, 'c:b');
    const ok = await svc.submit('p', { sessionId: b.sessionId, token: b.token, inputs: whip(b, 3), resultHash: HASH_A });
    expect(ok.cleared).toBe(true);
    expect(ok.evaluation.place).toBe(2);
    expect(w.repo.get('p')!.items.breeding_material ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('not trusted: a hash the server cannot reproduce is rejected; a lost race is a fail whatever the client shows', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const svc = service(w, new FakeVerifier(1, 1800, HASH_B));
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:x');
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('CHALLENGE_RESULT_MISMATCH');
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('CHALLENGE_SESSION_USED');
    const lost = service(w, new FakeVerifier(4));
    const st2 = await lost.start('p', NIGE.id, { loan: true }, 'c:y');
    const r = await lost.submit('p', { sessionId: st2.sessionId, token: st2.token, inputs: [], resultHash: HASH_A });
    expect(r.cleared).toBe(false);
    expect(r.evaluation.place).toBe(4);
    const dnf = service(w, new FakeVerifier(null));
    const st3 = await dnf.start('p', RAIN.id, { loan: true }, 'c:z');
    const r3 = await dnf.submit('p', { sessionId: st3.sessionId, token: st3.token, inputs: [], resultHash: HASH_A });
    expect(r3.evaluation.finished).toBe(false);
    expect(r3.evaluation.timeMs).toBeNull();
    expect(r3.cleared).toBe(false);
    expect(w.repo.get('p')!.weeklyChallenge!.weeks['2026-11-02']!.cleared).toEqual({});
  });

  it('inputs: only the player slot, client bits, increasing ticks; another player\'s token, an expired session, a changed config', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    await w.svc.bootstrap('q');
    const ver = new FakeVerifier(1);
    const svc = service(w, ver);
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:i');
    const other = (st.playerSlot + 1) % st.config.entrants.length;
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[60, other, 1]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[60, st.playerSlot, 64]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [[60, st.playerSlot, 1], [60, st.playerSlot, 32]], resultHash: HASH_A }))).toBe('BAD_REQUEST');
    expect(await code(svc.submit('q', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('UNAUTHORIZED');
    const tampered = structuredClone(st.config);
    tampered.entrants[st.playerSlot]!.horse.speed += 100;
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A, config: tampered }))).toBe('TA_CONFIG_MISMATCH');
    expect(ver.calls).toHaveLength(0);
    w.setNow(st.expiresAt + 1);
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('CHALLENGE_SESSION_EXPIRED');
  });

  it('a verifier outage leaves the session open for a retry', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const ver = new FakeVerifier(1);
    const svc = service(w, ver);
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:v');
    ver.fail = true;
    expect(await code(svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }))).toBe('VERIFIER_UNAVAILABLE');
    ver.fail = false;
    expect((await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A })).cleared).toBe(true);
  });
});

describe('weekly badge (REQ-WCH-009/010)', () => {
  it('clearing all 3 in one week earns the week\'s cosmetic badge once; nothing random and nothing else is added', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const svc = service(w, new FakeVerifier(1, 1500));
    const results: WchResult[] = [];
    for (const ch of WEEK0.challenges) {
      const st = await svc.start('p', ch.id, { loan: true }, `c:${ch.id}`);
      results.push(await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A }));
    }
    expect(results.map((r) => r.cleared)).toEqual([true, true, true]);
    expect(results.map((r) => r.badge.newlyEarned)).toEqual([false, false, true]);
    expect(results[2]!.clearedCount).toBe(3);
    const s = w.repo.get('p')!;
    expect(s.weeklyChallenge!.badges).toEqual([{ weekId: '2026-11-02', badgeId: WEEK0.badge.id, at: T0 }]);
    // the badge is not an item, a horse, coins or a title: only the badge record
    const coins = WEEK0.challenges.reduce((a, c) => a + (c.reward.freeCoins ?? 0), 0);
    const material = WEEK0.challenges.reduce((a, c) => a + (c.reward.items ?? []).reduce((x, i) => x + i.qty, 0), 0);
    expect(s.wallet.free).toBe(coins);
    expect(s.items.breeding_material ?? 0).toBe(material);
    expect(s.wallet.paid).toBe(0);
    expect(s.items[WEEK0.badge.id]).toBeUndefined();
    // a repeat after the badge does not earn it again
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:again');
    const r = await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A });
    expect(r.badge).toEqual({ id: WEEK0.badge.id, name: WEEK0.badge.name, earned: true, newlyEarned: false });
    expect(w.repo.get('p')!.weeklyChallenge!.badges).toHaveLength(1);
    expect(w.kpi.filter((k) => k.name === 'challenge_clear' && k.value === 1)).toHaveLength(1);
    const v = await w.svc.wchView('p');
    if (!v.enabled) throw new Error();
    expect(v.badge.earned).toBe(true);
    expect(v.badgeCount).toBe(1);
  });

  it('weekly rollover: a run started before 04:00 Monday counts for its own week; the new week starts with nothing cleared', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const svc = service(w, new FakeVerifier(1));
    const end = weekAt(m, cfg, T0).endsAt;
    w.setNow(end - 60_000);
    const st = await svc.start('p', NIGE.id, { loan: true }, 'c:late');
    w.setNow(end + 60_000);
    const r = await svc.submit('p', { sessionId: st.sessionId, token: st.token, inputs: [], resultHash: HASH_A });
    expect(r.weekId).toBe('2026-11-02');
    expect(r.credited).toBe(true);
    expect(r.firstClear).toBe(true);
    const v = await w.svc.wchView('p');
    if (!v.enabled) throw new Error();
    expect(v.weekId).toBe('2026-11-09');
    expect(v.clearedCount).toBe(0);
    expect(v.challenges.every((c) => !c.progress.cleared && c.progress.attempts === 0)).toBe(true);
    // last week's challenge can no longer be started
    expect(await code(w.svc.wchStart('p', NIGE.id, { loan: true }))).toBe('NOT_FOUND');
  });
});

describe('a rotation edited mid-session (remote config, REQ-WCH-012)', () => {
  it('the run is judged on the conditions and paid the reward shown at its start', async () => {
    let master: Master = m;
    let now = T0;
    const repo = new MemoryPlayerRepo();
    const svc0 = new PlayerService(repo, { master: m, rng: seededRng(9), clock: () => now, verifiers: {} });
    await svc0.bootstrap('p');
    const st = await svc0.wchStart('p', WHIP3.id, { loan: true });
    // an operator tightens the challenge to "no whip" and removes its reward while the run is on the device
    const edited = structuredClone(cfg);
    edited.rotation[0]!.challenges[1]!.conditions = { maxWhips: 0, maxPlace: 1 };
    edited.rotation[0]!.challenges[1]!.reward = { items: [{ itemId: 'breeding_material', qty: 2 }] };
    master = { ...m, progression: { ...m.progression, weeklyChallenge: edited } } as Master;
    const svc1 = new PlayerService(repo, { master, rng: seededRng(9), clock: () => now, verifiers: {} });
    await svc1.wchPrepare('p', st.sessionId, [[60, st.playerSlot, 1], [900, st.playerSlot, 32]], HASH_A, undefined);
    const order = [st.playerSlot, ...st.config.entrants.map((e) => e.slot).filter((x) => x !== st.playerSlot)];
    order.splice(0, 1); order.splice(1, 0, st.playerSlot); // 2nd place
    const r = await svc1.wchRecord('p', st.sessionId, { resultHash: HASH_A, order, finishTicks: order.map((_, i) => 1800 + i), finishFracs: order.map(() => 0), checksums: {} }, HASH_A);
    if ('rejected' in r) throw new Error();
    expect(r.cleared).toBe(true); // 2nd with 1 whip meets "3 whips, top 3" (the rules at the start)
    expect(r.reward).toEqual(WHIP3.reward);
    expect(repo.get('p')!.items.breeding_material).toBe(1);
    now += 1;
  });
});

describe('evaluation (REQ-WCH-005, shared with C# ChallengeEvaluator)', () => {
  it('place, time (the time attack formula with the fraction), whips of the slot, style; DNF fails every challenge', async () => {
    const w = setup();
    await w.svc.bootstrap('p');
    const st = await w.svc.wchStart('p', WHIP3.id, { loan: true });
    const out = { order: [st.playerSlot, ...st.config.entrants.map((e) => e.slot).filter((x) => x !== st.playerSlot)], finishTicks: st.config.entrants.map((_, i) => 1700 + i), finishFracs: st.config.entrants.map(() => 32768) };
    const ev = evaluateChallenge({ maxPlace: 3, maxWhips: 1, maxTimeMs: 100_000 }, st.config, st.playerSlot, [[60, st.playerSlot, 1], [900, st.playerSlot, 33], [950, (st.playerSlot + 1) % 8, 32]], out);
    expect(ev.place).toBe(1);
    expect(ev.whips).toBe(1); // a whip pressed together with START counts; another slot's never does
    expect(ev.timeMs).toBe(raceTimeMs(st.config, 1700, 32768));
    expect(ev.cleared).toBe(ev.timeMs! <= 100_000);
    const dnf = evaluateChallenge({ maxWhips: 3 }, st.config, st.playerSlot, [], { order: out.order, finishTicks: out.finishTicks.map((t, i) => (i === 0 ? -1 : t)), finishFracs: out.finishFracs });
    expect(dnf.finished).toBe(false);
    expect(dnf.cleared).toBe(false);
  });
});

describe('validation (REQ-WCH-012)', () => {
  const withCfg = (patch: (c: WeeklyChallengeConfig) => void) => {
    const c = structuredClone(cfg);
    patch(c);
    return weeklyChallengeProblems({ ...m, progression: { ...m.progression, weeklyChallenge: c } } as Master).join('\n');
  };
  it('the shipped table is valid', () => {
    expect(weeklyChallengeProblems(m)).toEqual([]);
  });
  it('refuses wrong goings, night at unlit venues, unknown courses / loan horses, a loan that does not fit', () => {
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.going = 'sloppy'; })).toMatch(/not a turf going/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.night = true; })).toMatch(/no floodlights/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.trackId = 'nowhere'; })).toMatch(/unknown course/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.loanTemplateId = 't_nobody'; })).toMatch(/unknown horse/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.loanTemplateId = 't_akatsuki'; })).toMatch(/required style nige/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.loanTemplateId = 't_dorobune'; })).toMatch(/does not fit/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.loanTemplateId = 't_hatsuyuki'; })).toMatch(/seasonal/);
  });
  it('refuses conditions that mean nothing, a wrong anchor weekday, duplicates, not exactly 3 a week', () => {
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.conditions = {}; })).toMatch(/at least one condition/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.conditions = { style: 'nige' }; })).toMatch(/style alone/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.conditions.maxPlace = 8; })).toMatch(/smaller than the field/);
    expect(withCfg((c) => { c.anchorWeekId = '2026-11-03'; })).toMatch(/must be a Monday/);
    expect(withCfg((c) => { c.rotation[1]!.challenges[0]!.id = NIGE.id; })).toMatch(/duplicate challenge id/);
    expect(withCfg((c) => { c.rotation[1]!.badge.id = WEEK0.badge.id; })).toMatch(/duplicate badge/);
    expect(withCfg((c) => { c.rotation[0]!.challenges.pop(); })).toMatch(/challenges/);
  });
  it('rewards: free coins and breeding material only, ≤ ¥200 a grant, ≤ the weekly ceiling; no tickets or random items; no paid coins', () => {
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.reward = { items: [{ itemId: 'gacha_ticket', qty: 1 }] }; })).toMatch(/only breeding_material/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.reward = { freeCoins: 101 }; })).toMatch(/freeCoins/);
    expect(withCfg((c) => { (c.rotation[0]!.challenges[0]!.reward as Record<string, unknown>).paidCoins = 10; })).toMatch(/paidCoins|Unrecognized/);
    expect(withCfg((c) => { (c.rotation[0]!.challenges[0]!.reward as Record<string, unknown>).horse = 't_akatsuki'; })).toMatch(/horse|Unrecognized/);
    expect(withCfg((c) => { for (const ch of c.rotation[0]!.challenges) ch.reward = { freeCoins: 60 }; })).toMatch(/at most 150/);
    expect(withCfg((c) => { c.rotation[0]!.challenges[0]!.reward = {}; })).toMatch(/needs free coins or material/);
    // the ceiling holds at the worst pack price
    expect(Math.round(WCH_HARD_LIMITS.freeCoinsPerChallenge * worstYenPerCoin(m))).toBeLessThanOrEqual(200);
    // the badge carries no reward key at all
    expect(withCfg((c) => { (c.rotation[0]!.badge as Record<string, unknown>).reward = { freeCoins: 10 }; })).toMatch(/Unrecognized/);
  });
  it('the loan horse is lifted to exactly the cap and keeps its template shape', () => {
    for (const w of cfg.rotation) for (const ch of w.challenges) {
      const h = loanRaceHorse(m, cfg, ch);
      expect(STAT_KEYS.reduce((a, k) => a + h[k], 0)).toBe(cfg.statCap);
      expect(h.skill).toBeUndefined();
      const t = m.templateById.get(ch.loanTemplateId)!;
      expect(h.style).toBe(t.style);
      expect(h.speed >= h.temper).toBe(t.stats.speed >= t.stats.temper);
    }
  });
});

describe('HTTP (REQ-WCH-002/003/008) and English (REQ-WCH-015)', () => {
  it('GET / start (keyed) / submit; strict bodies; every text in English with ?lang=en', async () => {
    const w = setup();
    await w.svc.bootstrap('p1');
    const wc = service(w, new FakeVerifier(1));
    const ctx = { master: m, authenticate: async (r: Request) => r.headers.get('x-test-user') ?? '', player: () => w.invoker, weeklyChallenge: wc, clock: w.now } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': 'p1', 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, ctx);
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const v = await call('GET', '/v1/challenges/weekly');
    expect(v.status).toBe(200);
    expect(v.json.weekId).toBe('2026-11-02');
    expect((await call('POST', `/v1/challenges/weekly/${NIGE.id}/start`, { loan: true })).status).toBe(400); // idempotency key required
    expect((await call('POST', `/v1/challenges/weekly/${NIGE.id}/start`, { loan: true, horseId: 'h1' }, { 'idempotency-key': 'k0' })).status).toBe(400);
    const st = await call('POST', `/v1/challenges/weekly/${NIGE.id}/start`, { loan: true }, { 'idempotency-key': 'k1' });
    expect(st.status).toBe(200);
    const st2 = await call('POST', `/v1/challenges/weekly/${NIGE.id}/start`, { loan: true }, { 'idempotency-key': 'k1' });
    expect(st2.json.sessionId).toBe(st.json.sessionId);
    const sub = await call('POST', '/v1/challenges/weekly/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A });
    expect(sub.status).toBe(200);
    expect(sub.json.cleared).toBe(true);
    expect((await call('POST', '/v1/challenges/weekly/submit', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A, extra: 1 })).status).toBe(400);
    const en = await call('GET', '/v1/challenges/weekly?lang=en');
    expect(untranslated(en.json, PLAYER_TEXT_KEYS)).toEqual([]);
    const enSub = await call('POST', '/v1/challenges/weekly/submit?lang=en', { sessionId: st.json.sessionId, token: st.json.token, inputs: [], resultHash: HASH_A });
    expect(untranslated(enSub.json, PLAYER_TEXT_KEYS)).toEqual([]);
    // no service → NOT_FOUND
    const none = await handle(new Request('https://x/v1/challenges/weekly', { headers: { 'x-test-user': 'p1' } }), {}, { ...ctx, weeklyChallenge: undefined } as AppContext);
    expect(none.status).toBe(404);
  });

  it('every week of the table and every condition label reads in English (no 倍 / urgency wording in either language)', async () => {
    const cat = catalogFor(m);
    const w = setup();
    await w.svc.bootstrap('p');
    for (let off = 0; off < cfg.rotation.length; off++) {
      w.setNow(T0 + off * 7 * 86_400_000);
      const v = await w.svc.wchView('p');
      expect(untranslated(localize(v, 'en', cat), PLAYER_TEXT_KEYS)).toEqual([]);
      expect(JSON.stringify(v)).not.toMatch(/倍|今だけ|残りわずか|お得|通常価格/);
      expect(JSON.stringify(localize(v, 'en', cat))).not.toMatch(/double|2x|limited time|hurry/i);
    }
    for (const lbl of conditionLabels({ maxPlace: 3, style: 'oikomi', maxWhips: 0, maxTimeMs: 61_000 })) expect(untranslated(localize(lbl, 'en', cat))).toEqual([]);
  });
});

describe('shared evaluation example (the same numbers as C# WeeklyChallengeTests.SharedEvaluationExampleMatchesTheServer)', () => {
  it('golden wa_whip3 config: 2nd place, 89 280 ms, 2 whips of the slot, senko, cleared', () => {
    const cfgJson = JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/golden/ts-config-challenge-wa_whip3.json'), 'utf8')) as RaceStartConfig;
    const slot = cfgJson.entrants.findIndex((e) => e.kind === 'human');
    expect(slot).toBe(2);
    const o1 = (slot + 1) % 8;
    const order = [o1, slot, ...[0, 1, 2, 3, 4, 5, 6, 7].filter((x) => x !== slot && x !== o1)];
    const out = { order, finishTicks: order.map((_, i) => 1840 + i * 5), finishFracs: order.map((_, i) => 40000 + i) };
    const ev = evaluateChallenge({ maxPlace: 3, maxWhips: 3, maxTimeMs: 100000 }, cfgJson, slot, [[59, slot, 1], [1200, slot, 32], [1300, slot, 33], [1400, o1, 32]], out);
    expect(ev).toMatchObject({ finished: true, place: 2, timeMs: 89280, whips: 2, style: 'senko', cleared: true });
    expect(ev.checks.map((c) => c.kind)).toEqual(['finish', 'place', 'whips', 'time']);
  });
});
