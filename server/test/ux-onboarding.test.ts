import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';
import { bannerProblems, validateGacha } from '../src/domain/gacha.js';
import { srPlusPool } from '../src/domain/itemShop.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { newPlayer } from '../src/domain/player.js';
import { MatchmakerCore } from '../src/domain/matchmaker.js';
import { rankedMatchRules } from '../src/race/orchestrate.js';
import { bucketOf, experimentsView, uxProblems, type ExperimentDef } from '../src/domain/onboarding.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { enqueuePush, registerDevice } from '../src/domain/push.js';
import { beatenFriends } from '../src/race/timeAttack.js';
import { DAY_ROLLOVER_HOUR_JST, gameDayIndex, gameDayKey, jstDateKey } from '../src/domain/time.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { m } from './helpers.js';

const T0 = Date.UTC(2026, 10, 5, 3); // 12:00 JST
const DAY = 86_400_000;

function setup(master: Master = m, start = T0) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: { fake: store }, onKpi: (_id, r) => { kpi.push(...r); } });
  let n = 0;
  const race = (id: string, place: number, mode: 'ranked' | 'friend' = 'ranked') =>
    svc.applyRace(id, { raceId: `r${++n}`, mode, place, fieldSize: 12, newRating: null, void: false, humans: mode === 'friend' ? 2 : 1 });
  return { svc, repo, store, kpi, race, set: (t: number) => { now = t; }, advance: (ms: number) => { now += ms; }, now: () => now };
}
const state = (repo: MemoryPlayerRepo, id: string) => JSON.parse(repo.data.get(id)!);
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('REQ-UXS-001 terms consent', () => {
  it('is required until the current versions are recorded, and again after a version bump', async () => {
    const { svc } = setup();
    expect((await svc.bootstrap('p')).consent).toMatchObject({ required: true, termsVersion: null, current: m.progression.consent });
    expect(await code(svc.recordConsent('p', '2026-01-01', m.progression.consent!.privacyVersion))).toBe('CONSENT_VERSION_MISMATCH');
    const r = await svc.recordConsent('p', m.progression.consent!.termsVersion, m.progression.consent!.privacyVersion);
    expect(r).toMatchObject({ required: false, termsVersion: '2026-11-01', consentedAt: T0 });
    const bumped = { ...m, progression: { ...m.progression, consent: { termsVersion: '2027-01-01', privacyVersion: '2026-11-01' } } };
    svc.setMaster(bumped);
    expect((await svc.view('p')).consent).toMatchObject({ required: true, termsVersion: '2026-11-01' });
    await svc.recordConsent('p', '2027-01-01', '2026-11-01');
    const s = await svc.state('p');
    expect(s.consent!.history.map((h) => h.termsVersion)).toEqual(['2026-11-01', '2027-01-01']);
  });
});

describe('REQ-UXS-002 first partner', () => {
  it('is granted once, named, separate from the free 10-pull', async () => {
    const { svc } = setup();
    expect(await code(svc.grantPartner('p', 'ダービー', 'c:/v1/player/partner:1'))).toBe('NG_NAME');
    const r = await svc.grantPartner('p', 'あかつき', 'c:/v1/player/partner:2');
    expect(r.horse).toMatchObject({ templateId: 't_partner', name: 'アカツキ', named: true, status: 'active', rarity: 'SR' });
    expect(await svc.grantPartner('p', 'あかつき', 'c:/v1/player/partner:2')).toEqual(JSON.parse(JSON.stringify(r))); // same key: same result
    expect(await code(svc.grantPartner('p', 'ベツノナマエ', 'c:/v1/player/partner:3'))).toBe('PARTNER_ALREADY_GRANTED');
    const g = await svc.tutorialDraw('p', 'c:/v1/gacha/tutorial:1');
    expect(g.results).toHaveLength(10);
    expect(g.results.every((x) => x.templateId !== 't_partner')).toBe(true);
    expect((await svc.view('p')).flags.partnerHorseId).toBe(r.horse.id);
  });

  it('gift-only horses are never in gacha pools, ticket tables or CPU fields', () => {
    const gift = m.templates.filter((t) => t.giftOnly).map((t) => t.id);
    expect(gift.sort()).toEqual(['t_broodmare', 't_partner']);
    for (const b of m.gacha.banners) for (const e of [...b.pool, ...b.guaranteePool]) expect(gift).not.toContain(e.templateId);
    expect(srPlusPool(m, 'ticket_sr_plus').some((e) => gift.includes(e.templateId))).toBe(false);
    const b = m.gacha.banners[0]!;
    expect(bannerProblems({ ...b, pool: [{ templateId: 't_partner', ppm: 1_000_000 }] }, m, m.gacha).join()).toMatch(/gift-only t_partner/);
    for (let seed = 1; seed <= 40; seed++) {
      const cfg = buildRaceConfig(m, { raceId: `r${seed}`, mode: 'ranked', trackId: 'aoba_turf_1600', humans: [], cpuCount: 12, cpuLevel: 3, statCap: 2800, rng: seededRng(seed) });
      expect(cfg.entrants.some((e) => gift.some((g) => e.horse.id === `cpu_${g}`))).toBe(false);
    }
  });
});

describe('REQ-UXS-003 first ranked race and beginner CPUs', () => {
  it('a first-race entry fills with CPUs after 5 s instead of 15 s', () => {
    const q = new MatchmakerCore<unknown>();
    q.enqueue({ playerId: 'new', rating: 1500, beginner: true, enqueuedAt: 0, payload: null, cpuFillAfterMs: 5000 });
    q.enqueue({ playerId: 'old', rating: 1500, beginner: false, enqueuedAt: 0, payload: null });
    expect(q.tick(4999)).toHaveLength(0);
    const at5 = q.tick(5000);
    expect(at5.map((x) => x.players.map((p) => p.playerId))).toEqual([['new']]);
    expect(q.tick(14_999)).toHaveLength(0);
    expect(q.tick(15_000)).toHaveLength(1);
  });

  it('race entries carry the first-race rules until the first ranked race', async () => {
    const { svc, race } = setup();
    const { horse } = await svc.grantPartner('p', 'アイボウ', 'c:k1');
    expect((await svc.raceEntry('p', horse.id)).firstRace).toEqual({ cpuFillAfterMs: 5000, trackId: null });
    await race('p', 4);
    expect((await svc.raceEntry('p', horse.id)).firstRace).toBeNull();
  });

  it('beginner matches use the beginner CPU level and stat permille (CPU only)', () => {
    const bm = m.progression.beginnerMatch!;
    const entry = (first: string | null) => ({ firstRace: first === undefined ? null : { cpuFillAfterMs: 5000, trackId: first } }) as never;
    const rules = rankedMatchRules(m, { players: [{ playerId: 'a', rating: 1500, beginner: true, enqueuedAt: 0, payload: entry('aoba_turf_1600') }], cpuCount: 11, cpuLevel: 1, beginner: true, quarantined: false });
    expect(rules).toEqual({ cpuCount: 11, cpuLevel: bm.cpuLevel, cpuStatPermille: 780, trackId: 'aoba_turf_1600' });
    const normal = rankedMatchRules(m, { players: [{ playerId: 'a', rating: 1500, beginner: false, enqueuedAt: 0, payload: entry(null) }], cpuCount: 11, cpuLevel: 4, beginner: false, quarantined: false });
    expect(normal).toEqual({ cpuCount: 11, cpuLevel: 4 });
    const p = newPlayer('x', 0, '2026-11');
    const human = { playerId: 'x', horse: toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get('t_partner')!, 0)) };
    const mk = (pm?: number) => buildRaceConfig(m, { raceId: 'r', mode: 'ranked', trackId: 'aoba_turf_1600', humans: [human], cpuCount: 11, cpuLevel: 1, statCap: 2800, rng: seededRng(3), ...(pm ? { cpuStatPermille: pm } : {}) });
    const a = mk(), b = mk(780);
    for (let i = 0; i < 12; i++) {
      const ea = a.entrants[i]!, eb = b.entrants[i]!;
      if (ea.kind === 'human') expect(eb.horse).toEqual(ea.horse);
      else expect(eb.horse.speed).toBe(Math.floor((ea.horse.speed * 780) / 1000));
    }
  });
});

describe('REQ-UXS-013 beginner login bonus', () => {
  it('7 beginner days once (day 2 = a broodmare), then the normal cycle', async () => {
    const { svc, advance } = setup();
    const days = [];
    for (let i = 0; i < 9; i++) { days.push(await svc.claimLogin('p', `c:lb${i}`)); advance(DAY); }
    expect(days.map((d) => `${d.track}${d.day}`)).toEqual(['beginner1', 'beginner2', 'beginner3', 'beginner4', 'beginner5', 'beginner6', 'beginner7', 'normal1', 'normal2']);
    const mares = (await svc.state('p')).horses.filter((h) => h.templateId === 't_broodmare');
    expect(mares).toHaveLength(1);
    expect(mares[0]).toMatchObject({ sex: 'female', status: 'retired' });
    expect(days[8]!.reward).toEqual(m.progression.loginBonus[1]);
  });

  it('players who claimed before the beginner table existed stay on the normal cycle', async () => {
    const { svc, repo } = setup();
    await svc.bootstrap('old');
    const s = state(repo, 'old');
    s.loginBonus = { streakDay: 3, lastClaimDate: '2026-11-01' };
    repo.data.set('old', JSON.stringify(s));
    expect(await svc.claimLogin('old', 'c:x')).toMatchObject({ track: 'normal', day: 4 });
  });
});

describe('REQ-UXS-014 unlocks', () => {
  it('opens features by races or days, whichever comes first (display only)', async () => {
    const { svc, race, advance } = setup();
    const f = async () => Object.fromEntries((await svc.view('p')).unlocks.features.map((x) => [x.key, x.unlocked]));
    let u = await f();
    expect(u).toMatchObject({ race: true, scout: true, missions: false, breeding: false, season: false, my_stable: false });
    await race('p', 5); await race('p', 6);
    u = await f();
    expect(u).toMatchObject({ missions: true, login_bonus: true, shop: false });
    advance(DAY);
    const v = (await svc.bootstrap('p')).unlocks;
    expect(v).toMatchObject({ day: 2, races: 2, rankedRaces: 2 });
    expect(v.features.find((x) => x.key === 'breeding')).toMatchObject({ unlocked: true, by: 'days', days: 2, races: 8 });
    expect(v.features.find((x) => x.key === 'teams')).toMatchObject({ unlocked: false, by: null });
    for (let i = 0; i < 3; i++) await race('p', 2);
    expect((await f()).season).toBe(true); // 5 ranked races
  });
});

describe('REQ-UXS-015 beginner missions', () => {
  it('10 steps, one at a time; the last gives a 10-pull ticket', async () => {
    const { svc } = setup();
    expect(m.progression.beginnerMissions).toHaveLength(10);
    let v = (await svc.missionsAll('p')).beginner;
    expect(v.steps[0]).toMatchObject({ id: 'bm_scout', claimable: false, locked: false });
    expect(v.steps[1]).toMatchObject({ locked: true });
    await svc.tutorialDraw('p', 'c:t');
    await svc.setSilks('p', (await svc.view('p')).profile.silks);
    expect(await code(svc.claimMission('p', 'bm_silks', 'c:m0'))).toBe('NOT_ELIGIBLE'); // step 1 first
    expect(await svc.claimMission('p', 'bm_scout', 'c:m1')).toEqual({ freeCoins: 50 });
    expect(await svc.claimMission('p', 'bm_silks', 'c:m2')).toEqual({ freeCoins: 50 });
    expect(await code(svc.claimMission('p', 'bm_scout', 'c:m3'))).toBe('ALREADY_CLAIMED');
    v = (await svc.missionsAll('p')).beginner;
    expect(v.steps[2]).toMatchObject({ id: 'bm_care', progress: 0, claimable: false });
    expect(m.progression.beginnerMissions!.at(-1)!.reward).toEqual({ items: [{ itemId: 'gacha_ticket_10', qty: 1 }] });
  });

  it('the 10-pull ticket draws ten from the banner with the slot-10 guarantee and ten pity points', async () => {
    const { svc, repo } = setup();
    await svc.bootstrap('p');
    const s = state(repo, 'p'); s.items.gacha_ticket_10 = 1; repo.data.set('p', JSON.stringify(s));
    const r = await svc.useTicket('p', 'gacha_ticket_10', 'standard', 'c:u1');
    expect(r.results).toHaveLength(10);
    expect(r.pityPoints).toBe(10);
    expect(r.results!.some((x) => x.rarity !== 'R')).toBe(true);
    expect(await code(svc.useTicket('p', 'gacha_ticket_10', 'standard', 'c:u2'))).toBe('INSUFFICIENT_ITEMS');
  });

  it('a "collect" beginner or season mission on gacha-only horses fails the comp-gacha check (REQ-GACHA-008)', () => {
    const bad = { ...m, progression: { ...m.progression, beginnerMissions: [...m.progression.beginnerMissions!, { id: 'bm_set', kind: 'collect' as const, target: 2, templateIds: ['t_akatsuki', 't_ginga'], reward: { freeCoins: 10 } }] } };
    expect(() => validateGacha(bad)).toThrow(/comp gacha/);
    const bad2 = { ...m, progression: { ...m.progression, seasonMissions: [...m.progression.seasonMissions!, { id: 'sm_set', kind: 'collect' as const, target: 2, templateIds: ['t_akatsuki', 't_ginga'], reward: { passXp: 10 } }] } };
    expect(() => validateGacha(bad2)).toThrow(/comp gacha/);
    expect(() => validateGacha(m)).not.toThrow();
  });
});

describe('REQ-UXS-016 season missions', () => {
  it('ranked wins and races give pass XP once per season', async () => {
    const { svc, race } = setup();
    for (let i = 0; i < 10; i++) await race('p', i < 5 ? 1 : 3);
    const v = (await svc.missionsAll('p')).season;
    expect(v.missions.find((x) => x.id === 'sm_wins5')).toMatchObject({ progress: 5, claimable: true });
    const xp = (await svc.state('p')).seasonPass.xp;
    expect(await svc.claimMission('p', 'sm_wins5', 'c:s1')).toEqual({ passXp: 150 });
    expect(await svc.claimMission('p', 'sm_races10', 'c:s2')).toEqual({ passXp: 100 });
    expect((await svc.state('p')).seasonPass.xp).toBe(xp + 250);
    expect(await code(svc.claimMission('p', 'sm_wins5', 'c:s3'))).toBe('ALREADY_CLAIMED');
    // promotion line: C class needs 300 points (10 races here: 5×30 + 5×15 = 225)
    expect(v.missions.find((x) => x.id === 'sm_promotion')).toMatchObject({ target: 300, progress: 225, claimable: false });
  });
});

describe('REQ-UXS-012 push templates and daily cap', () => {
  it('the default daily cap is 2 and the new templates exist in their categories', () => {
    expect(m.push.defaults.dailyCap).toBe(2);
    expect(m.push.templates.promotion_near!.category).toBe('season');
    expect(m.push.templates.tournament_closing!.category).toBe('events');
    expect(m.push.templates.ta_beaten!.category).toBe('friends');
    const s = newPlayer('p', T0, '2026-11');
    registerDevice(m, s, 'tok-aaaaaaaa', 'ios', T0);
    expect([1, 2, 3].map(() => enqueuePush(m, s, 'friend_request', { name: 'A' }, T0).status)).toEqual(['queued', 'queued', 'skipped']);
  });

  it('promotion nudge: close to the line and 24 h without a ranked race, once per season', async () => {
    const { svc, race, advance } = setup();
    await svc.registerDevice('p', 'tok-aaaaaaaa', 'ios');
    for (let i = 0; i < 9; i++) await race('p', 1); // 270 pt, 30 to the C line
    const s = await svc.state('p');
    expect(s.nudges!.promotion!.checkAt).toBe(T0 + DAY);
    expect(await svc.nextWakeOf('p')).toBe(T0 + DAY);
    advance(DAY - 1);
    expect(await svc.runNudges('p')).toBeNull();
    advance(1);
    expect(await svc.runNudges('p')).toMatchObject({ status: 'queued' });
    const out = (await svc.state('p')).push!.outbox;
    expect(out.at(-1)).toMatchObject({ templateId: 'promotion_near', vars: { points: '30' } });
    await race('p', 12);
    expect((await svc.state('p')).nudges!.promotion).toMatchObject({ sent: true, checkAt: null });
  });

  it('TA beaten: friends this run passed, notified at most once a day; tournament closing checks eligibility', async () => {
    const e = (id: string, t: number) => ({ playerId: id, finishTick: t, finishFrac: 0 }) as never;
    expect(beatenFriends([e('a', 900), e('b', 1100), e('c', 800)], { finishTick: 1000, finishFrac: 0 }, { finishTick: 850, finishFrac: 0 })).toEqual(['a']);
    expect(beatenFriends([e('a', 900), e('b', 1100)], null, { finishTick: 850, finishFrac: 0 })).toEqual(['a', 'b']);
    const { svc, advance } = setup();
    await svc.registerDevice('f', 'tok-bbbbbbbb', 'ios');
    expect(await svc.nudgeTaBeaten('f', 'ライバル', 'aoba_turf_1600')).toMatchObject({ status: 'queued' });
    expect(await svc.nudgeTaBeaten('f', 'ライバル', 'aoba_turf_1600')).toMatchObject({ status: 'skipped', reason: 'already_today' });
    advance(DAY);
    const info = { tournamentId: 'cup1', name: '秋の杯', classIds: ['B'], minRankedRaces: 0, minutes: 60 };
    expect(await svc.nudgeTournamentClosing('f', info)).toMatchObject({ status: 'skipped', reason: 'not_eligible' });
    expect(await svc.nudgeTournamentClosing('f', { ...info, classIds: ['C'] })).toMatchObject({ status: 'queued' });
    expect(await svc.nudgeTournamentClosing('f', { ...info, classIds: ['C'] })).toMatchObject({ status: 'skipped', reason: 'already' });
  });
});

describe('REQ-UXS-030 KPI client events', () => {
  const batch = (events: unknown[]) => ({ platform: 'ios', appVersion: '1.0.0', events });
  it('accepts the new events and only the fixed tutorial steps', () => {
    const ok = clientBatchSchema.safeParse(batch([
      { name: 'tutorial_step', at: T0, props: { step: 'race1_win', index: 4, value: 2 } },
      { name: 'tutorial_step', at: T0, props: { step: 'home' } },
      { name: 'feature_unlock', at: T0, props: { feature: 'breeding' } },
      { name: 'offer_view', at: T0, props: { offerId: 'starter', trigger: 'T2' } },
      { name: 'offer_click', at: T0, props: { offerId: 'starter', trigger: 'T2' } },
      { name: 'race_quit', at: T0, props: { mode: 'ranked', remainingM: 420 } },
      { name: 'account_link', at: T0, props: { provider: 'apple' } },
    ]));
    expect(ok.success).toBe(true);
    const ev = ok.success ? ok.data.events.map(clientToKpi) : [];
    expect(ev[0]).toEqual({ name: 'tutorial_step', s1: 'race1_win', value: 4, count: 2 });
    expect(ev[1]).toEqual({ name: 'tutorial_step', s1: 'home', value: 8 });
    expect(ev[3]).toEqual({ name: 'offer_view', s1: 'starter', s2: 'T2' });
    expect(ev[5]).toEqual({ name: 'race_quit', s1: 'ranked', value: 420 });
    for (const bad of [
      { name: 'tutorial_step', at: T0, props: { step: 'whip', index: 1 } },
      { name: 'tutorial_step', at: T0, props: { step: 'named', index: 2 } },
      { name: 'offer_view', at: T0, props: { offerId: 'starter', trigger: 'T9' } },
      { name: 'account_link', at: T0, props: { provider: 'line' } },
    ]) expect(clientBatchSchema.safeParse(batch([bad])).success).toBe(false);
  });
});

describe('REQ-UXS-032 A/B buckets', () => {
  const exp: ExperimentDef = { id: 'ab_home_button', active: true, buckets: [{ id: 'a', weight: 1, values: { homePrimaryButton: 'race' } }, { id: 'b', weight: 1, values: { homePrimaryButton: 'ranked_promotion' } }] };
  it('assigns by player id hash (stable, roughly even) and switches remote config values', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `player${i}`);
    const a = ids.filter((id) => bucketOf(exp, id) === 'a').length;
    expect(a).toBeGreaterThan(900); expect(a).toBeLessThan(1100);
    expect(bucketOf(exp, 'player7')).toBe(bucketOf(exp, 'player7'));
    const master = { ...m, progression: { ...m.progression, experiments: [exp] } };
    const v = experimentsView(master, 'player7');
    expect(v.values.homePrimaryButton).toBe(bucketOf(exp, 'player7') === 'a' ? 'race' : 'ranked_promotion');
    expect(experimentsView(m, 'player7')).toEqual({ assignments: {}, values: {} }); // shipped experiments are inactive
    const { svc, kpi } = setup(master);
    await svc.bootstrap('player7'); await svc.bootstrap('player7');
    expect(kpi.filter((r) => r.name === 'ab_assign').map((r) => [r.s1, r.s2])).toEqual([['ab_home_button', bucketOf(exp, 'player7')]]);
  });

  it('never switches prices: only the allowlisted keys are valid experiment values', () => {
    const known = new Set(collectItemIds(m));
    const withExp = (e: ExperimentDef) => uxProblems({ ...m, progression: { ...m.progression, experiments: [e] } }, known);
    expect(withExp(exp)).toEqual([]);
    const price: ExperimentDef = { id: 'ab_price', active: true, buckets: [{ id: 'a', weight: 1, values: { priceYen: 480 } }, { id: 'b', weight: 1, values: { priceYen: 360 } }] };
    expect(withExp(price).join()).toMatch(/priceYen is not an A\/B key.*never prices/);
    expect(() => resolveBundle(m, { progression: { experiments: [price] } })).toThrow(/never prices/);
    const badVal: ExperimentDef = { ...exp, buckets: [exp.buckets[0]!, { id: 'b', weight: 1, values: { homePrimaryButton: 'shop' } }] };
    expect(withExp(badVal).length).toBeGreaterThan(0);
  });
});

describe('remote config validation of the onboarding sections', () => {
  it('rejects bad values with the boot validators', () => {
    expect(uxProblems(m, new Set(collectItemIds(m)))).toEqual([]);
    expect(() => resolveBundle(m, { progression: { accountDeletion: { cancelWindowDays: 14, confirmTtlMs: 600000, ledgerRetentionDays: 30 } } })).toThrow(/ledgerRetentionDays/);
    expect(() => resolveBundle(m, { progression: { partner: { templateId: 't_akatsuki' } } })).toThrow(/gift-only/);
    expect(() => resolveBundle(m, { progression: { unlocks: [{ key: 'nope' }] } })).toThrow(/unlocks/);
    expect(() => resolveBundle(m, { progression: { beginnerLoginBonus: [{ day: 1, broodmare: 't_akatsuki' }] } })).toThrow(/broodmare/);
    expect(() => resolveBundle(m, { progression: { seasonMissions: [{ id: 'race3', kind: 'wins', target: 1, reward: { passXp: 10 } }] } })).toThrow(/already used/);
    expect(() => resolveBundle(m, { progression: { beginnerMatch: { firstRaceCpuFillAfterMs: 5000, cpuLevel: 1, cpuStatPermille: 780, firstRaceTrackId: 'nope' } } })).toThrow(/unknown track/);
    expect(() => resolveBundle(m, { progression: { nudges: { promotionNearPoints: 0, promotionIdleMs: 86400000, tournamentClosingLeadMs: 3600000, tournamentClosingMaxTargets: 10 } } })).toThrow(/promotionNearPoints/);
    expect(() => resolveBundle(m, { progression: { beginnerMatch: { firstRaceCpuFillAfterMs: 3000, cpuLevel: 1, cpuStatPermille: 800, firstRaceTrackId: null } } })).not.toThrow();
  });
});

describe('REQ-UXS-011 game day rollover', () => {
  it('one constant (midnight today); with 4 every game day moves to 04:00 JST', () => {
    expect(DAY_ROLLOVER_HOUR_JST).toBe(0);
    const at0330 = Date.UTC(2026, 10, 5, 18, 30); // 03:30 JST on the 6th
    expect(gameDayKey(at0330)).toBe('2026-11-06');
    expect(gameDayKey(at0330, 4)).toBe('2026-11-05');
    expect(gameDayKey(at0330 + 3_600_000, 4)).toBe('2026-11-06');
    expect(gameDayIndex(at0330, 4) - gameDayIndex(at0330 - 1_800_000, 4)).toBe(0);
    expect(jstDateKey(at0330)).toBe('2026-11-06'); // calendar date is not the game day
  });

  it('every daily rule goes through gameDayKey (calendar dates only where they must be)', () => {
    const dir = join(__dirname, '..', 'src');
    const calendarOk = new Set(['domain/time.ts', 'domain/kpi.ts', 'domain/accounting.ts', 'domain/service.ts', 'domain/push.ts']);
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith('.ts') && files.push(join(d, f.name)); };
    walk(dir);
    for (const f of files) {
      const rel = f.slice(dir.length + 1);
      const src = readFileSync(f, 'utf8');
      if (!calendarOk.has(rel)) expect(src.includes('jstDateKey('), rel).toBe(false);
    }
    // push.ts: the daily cap is a game day, season reminders are calendar dates
    expect(readFileSync(join(dir, 'domain/push.ts'), 'utf8')).toMatch(/const day = gameDayKey\(notBefore\)/);
  });
});

describe('REQ-UXS-040 account deletion', () => {
  it('two steps (token), purchases blocked while scheduled, cancellable within the window', async () => {
    const { svc, advance } = setup();
    await svc.bootstrap('p');
    expect(await code(svc.requestDeletion('p', 'del_wrong'))).toBe('DELETION_CONFIRM_INVALID');
    const step1 = await svc.requestDeletion('p', null);
    expect(step1).toMatchObject({ status: 'confirm_required', cancelWindowDays: 14, forfeit: { paidCoins: 0, freeCoins: 0 } });
    const token = (step1 as { confirmToken: string }).confirmToken;
    advance(11 * 60_000);
    expect(await code(svc.requestDeletion('p', token))).toBe('DELETION_CONFIRM_INVALID'); // expired
    const t2 = ((await svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    const sched = await svc.requestDeletion('p', t2);
    expect(sched).toMatchObject({ status: 'scheduled', deleteAt: svc['d'].clock() + 14 * DAY });
    expect(await svc.requestDeletion('p', null)).toMatchObject({ status: 'scheduled' }); // idempotent
    expect((await svc.view('p')).deletion.status).toBe('scheduled');
    expect(await svc.nextWakeOf('p')).toBe((sched as { deleteAt: number }).deleteAt);
    await svc.setAge('p', 1990, 1, false);
    expect(await code(svc.purchaseIntent('p', 'coin_160'))).toBe('DELETION_PENDING');
    expect(await svc.deletionDue('p')).toBe(false);
    expect(await svc.cancelDeletion('p')).toEqual({ status: 'none', requestedAt: null, deleteAt: null });
    expect(await code(svc.cancelDeletion('p'))).toBe('NOT_FOUND');
    expect(await code(svc.purchaseIntent('p', 'coin_160'))).not.toBe('DELETION_PENDING');
  });

  it('removes the player from friends and teams, keeps an anonymised ledger, then wipes; resumes after a failure', async () => {
    const { svc, repo, store, advance, now } = setup();
    const dir = new MemoryDirectory();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const friends = makeFriendsService(() => invoker, dir);
    for (const p of ['p', 'f1', 'f2', 'f3']) await svc.bootstrap(p);
    for (const p of ['p', 'f1', 'f2', 'f3']) await dir.putProfile({ playerId: p, displayName: p } as never);
    await friends.request('f1', await (await friends.myCode('p')).code);
    await friends.accept('p', 'f1');
    await friends.request('f2', (await friends.myCode('p')).code); // incoming for p
    await friends.request('p', (await friends.myCode('f3')).code); // outgoing from p
    await svc.setAge('p', 1990, 1, false);
    await svc.purchase('p', 'fake', 'coin_160', store.issue({ transactionId: 'TX1', productId: 'coin_160', purchasedAt: now(), priceYen: 160 }));
    await svc.recordConsent('p', '2026-11-01', '2026-11-01');
    const t = ((await svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await svc.requestDeletion('p', t);
    advance(14 * DAY);
    expect(await svc.deletionDue('p')).toBe(true);
    const calls: string[] = [];
    const retained: unknown[] = [];
    let failTeam = true;
    const ports: DeletionPorts = {
      snapshot: (u) => svc.deletionSnapshot(u),
      markStep: async (u, st) => { await svc.deletionMarkStep(u, st); },
      friends: {
        removeFriend: (o, u) => svc.friendRemove(o, u),
        dropOutgoing: (f, u) => svc.friendCancel(f, u),
        dropIncoming: (to, u) => svc.friendDecline(to, u),
      },
      team: {
        members: async () => [{ playerId: 'p', role: 'leader', joinedAt: 1 }, { playerId: 'm1', role: 'member', joinedAt: 2 }, { playerId: 'o1', role: 'officer', joinedAt: 3 }],
        leave: async (tid, u) => { calls.push(`leave:${tid}:${u}`); if (failTeam) { failTeam = false; throw new AppError('TEAM_LEADER_MUST_TRANSFER'); } },
        transfer: async (tid, u, to) => { calls.push(`transfer:${tid}:${u}:${to}`); },
        dropRequest: async () => undefined,
      },
      directory: { forget: async (u) => { calls.push(`dir:${u}`); } },
      leaderboards: { forget: async (u) => { calls.push(`lb:${u}`); }, deleteGhosts: async () => undefined },
      events: { forget: async () => undefined },
      tournaments: { forget: async (u) => { calls.push(`tour:${u}`); } },
      finalize: (u) => svc.deletionFinalize(u),
      retain: async (_u, r) => { if (retained.length === 0 && calls.includes('fail-retain-once') === false) { calls.push('fail-retain-once'); throw new Error('accounting down'); } retained.push(r); },
      wipe: (u) => svc.wipe(u),
    };
    // pretend the player leads a team
    const s = state(repo, 'p'); s.team = { teamId: 'tm1', joinedAt: 1, cooldownUntil: 0, joining: null, outgoing: [], rewarded: [] }; repo.data.set('p', JSON.stringify(s));
    await expect(runAccountDeletion(ports, 'p', now())).rejects.toThrow('accounting down');
    expect(await svc.deletionRetryLater('p')).toBe(now() + 60_000);
    const second = await runAccountDeletion(ports, 'p', now());
    expect(second.done).toEqual(['retain', 'wipe']); // resumed after the failed step
    expect(calls.filter((c) => c.startsWith('transfer'))).toEqual(['transfer:tm1:p:o1']); // officer first
    expect(calls).toContain('dir:p');
    expect(calls).toContain('tour:p');
    expect(repo.data.has('p')).toBe(false);
    for (const f of ['f1', 'f2', 'f3']) {
      const fs = await svc.friendsState(f);
      expect([...fs.ids, ...fs.incoming.map((x) => x.from), ...fs.outgoing.map((x) => x.to)]).not.toContain('p');
    }
    expect(retained).toHaveLength(1);
    const rec = retained[0] as { anonId: string; purchases: { txId: string }[]; ledger: { kind: string; delta: number }[]; forfeited: { paidCoins: number } };
    expect(rec.anonId).toMatch(/^anon_/);
    expect(rec.purchases.map((x) => x.txId)).toEqual(['TX1']);
    expect(rec.forfeited.paidCoins).toBe(100);
    expect(rec.ledger.filter((e) => e.kind === 'forfeit').map((e) => e.delta)).toContain(-100);
    const text = JSON.stringify(rec);
    for (const pii of ['"p"', '騎手', 'displayName', 'silks', 'tok-', 'birthYear']) expect(text).not.toContain(pii);
  });

  it('HTTP: DELETE /v1/player (with or without a body), POST /v1/player/deletion/cancel, consent and partner routes', async () => {
    const { svc } = setup();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: () => T0 } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    const s1 = await call('DELETE', '/v1/player');
    expect(s1.body).toMatchObject({ status: 'confirm_required' });
    expect((await call('DELETE', '/v1/player', { confirmToken: 'del_x' })).body.error.code).toBe('DELETION_CONFIRM_INVALID');
    expect((await call('DELETE', '/v1/player', { nope: 1 })).status).toBe(400);
    expect((await call('DELETE', `/v1/player?confirmToken=${s1.body.confirmToken}`)).body).toMatchObject({ status: 'scheduled' });
    expect((await call('POST', '/v1/player/deletion/cancel')).body).toMatchObject({ status: 'none' });
    expect((await call('POST', '/v1/player/consent', { termsVersion: '2026-11-01', privacyVersion: '2026-11-01' })).body).toMatchObject({ required: false });
    expect((await call('POST', '/v1/player/consent', { termsVersion: 'old', privacyVersion: '2026-11-01' })).body.error.code).toBe('CONSENT_VERSION_MISMATCH');
    expect((await call('POST', '/v1/player/partner', { name: 'アイボウ' })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call('POST', '/v1/player/partner', { name: 'アイボウ' }, { 'idempotency-key': 'k1' })).body.horse).toMatchObject({ templateId: 't_partner' });
    expect((await call('POST', '/v1/player/partner', { name: 'アイボウ' }, { 'idempotency-key': 'k2' })).body.error.code).toBe('PARTNER_ALREADY_GRANTED');
    const missions = (await call('GET', '/v1/missions')).body;
    expect(Object.keys(missions).sort()).toEqual(['beginner', 'missions', 'season']);
    const v = (await call('GET', '/v1/player')).body;
    expect(Object.keys(v)).toEqual(expect.arrayContaining(['consent', 'unlocks', 'experiments', 'deletion']));
  });
});
