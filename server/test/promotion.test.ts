/**
 * REQ-PROMO-001..020 (contracts/protocol.md §68): 昇級戦と降級の猶予. The rules (validation, the kill switch), the series
 * (start on reaching the line, pass / fail, setback, disconnect = miss, void / suspect / quarantined not counted, one count
 * per race id, out-of-order delivery), the season close (a running series resolves by the points, no carry-over), the grace
 * window and the shield (once per class per season), the season missions after a setback, the view and the ack, the KPI and
 * their §58 class, the §51 class, the maintenance group, the activity entry, the recap line, the help article and the tip,
 * and that ratings, coins and items are untouched.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import {
  PROMOTION_DEFAULTS, ackPromotion, closePromotionSeason, notePromotionRace, promotionProblems, promotionRulesOf, promotionView, seasonPointsEarned,
  type PromotionRules,
} from '../src/domain/promotion.js';
import { rollSeason } from '../src/domain/season.js';
import { classifyKey } from '../src/domain/dataExport.js';
import { endpointGroup, isExempt } from '../src/domain/maintenance.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { ACTIVITY_KINDS, ACTIVITY_META, activityText } from '../src/domain/activity.js';
import { ACTIVITY_KIND_NAMES as KPI_ACTIVITY_KINDS_FOR_TEST } from '../src/domain/kpi.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { fillTokens } from '../src/domain/help.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import { freshPlayer, m } from './helpers.js';

const NOV = Date.UTC(2026, 10, 10, 3);
const DEC = Date.UTC(2026, 11, 2, 3);
const JAN = Date.UTC(2027, 0, 2, 3);
const FEB = Date.UTC(2027, 1, 2, 3);
const RULES = promotionRulesOf(m);
const withRules = (o: Partial<PromotionRules> | null): Master => {
  const progression = { ...m.progression } as Master['progression'] & { promotion?: unknown };
  if (o === null) delete progression.promotion; else progression.promotion = { ...RULES, ...o };
  return { ...m, progression };
};
const OFF = withRules({ enabled: false });

let seq = 0;
function race(place: number, o: Partial<RaceResultForPlayer> & { cpu?: boolean } = {}): RaceResultForPlayer {
  const { cpu, ...rest } = o;
  seq++;
  return {
    raceId: `r_${seq}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, startAtMs: NOV + seq * 1000,
    ...(cpu !== undefined ? { details: { trackId: 'kirameki_turf_2000', style: 'senko', finishTick: 100, startReactionTicks: 2, whips: 2, whipMashed: false, cpuAssisted: cpu } } : {}),
    ...rest,
  };
}

function world(master: Master = m, now = NOV) {
  const clock = { now };
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => clock.now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  return { svc, clock, kpi, repo };
}
type W = ReturnType<typeof world>;
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;
const setPoints = (w: W, id: string, points: number) => w.svc.tx(id, null, (s) => { s.season.points = points; s.flags.tutorialGachaUsed = true; });
const promoKpi = (w: W) => w.kpi.filter((r) => /^promo_|^demotion_/.test(r.name)).map((r) => [r.name, r.s1, r.s2, r.s3 ?? null]);
const code = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === 'function' ? p() : p); return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('rules progression.promotion (REQ-PROMO-001/002)', () => {
  it('the shipped rules are valid and on; the master passes the boot / remote-config checks', () => {
    expect(promotionProblems(m)).toEqual([]);
    expect(RULES).toEqual({ enabled: true, races: 3, needTop: 2, topPlace: 3, setbackPoints: 40, graceRaces: 10 });
    expect(uxProblems(m, new Set(collectItemIds(m))).filter((p) => p.includes('promotion'))).toEqual([]);
  });
  it('rejects bad values, unknown keys and any reward key; a setback below a demotion line', () => {
    const bad = (o: Record<string, unknown>) => promotionProblems({ progression: { ...m.progression, promotion: { ...RULES, ...o } } } as Master);
    expect(bad({ races: 0 }).join()).toMatch(/races/);
    expect(bad({ races: 6 }).join()).toMatch(/races/);
    expect(bad({ needTop: 4 }).join()).toMatch(/needTop/);
    expect(bad({ topPlace: 13 }).join()).toMatch(/topPlace/);
    expect(bad({ graceRaces: -1 }).join()).toMatch(/graceRaces/);
    expect(bad({ enabled: 'yes' }).join()).toMatch(/enabled/);
    expect(bad({ setbackPoints: 0 }).join()).toMatch(/setbackPoints/);
    // B: line 400, demotion below 50 → a setback of 360 would drop under 50
    expect(bad({ setbackPoints: 360 }).join()).toMatch(/class B would fall below 50/);
    expect(bad({ reward: { coins: 10 } }).join()).toMatch(/never grants anything/);
    expect(bad({ bonusCoins: 1 }).join()).toMatch(/never grants anything/);
    expect(bad({ matchPreference: true }).join()).toMatch(/not a known key/);
    expect(promotionProblems({ progression: { ...m.progression, promotion: [] } } as unknown as Master)).toEqual(['progression.promotion must be an object']);
  });
  it('no section = off (the old behaviour)', () => {
    expect(promotionRulesOf(withRules(null))).toEqual(PROMOTION_DEFAULTS);
    expect(PROMOTION_DEFAULTS.enabled).toBe(false);
    expect(promotionProblems(withRules(null))).toEqual([]);
  });
});

describe('the series (REQ-PROMO-003..007)', () => {
  it('reaching the line starts a series (that race is not part of it); two top-3 pass it early', async () => {
    const w = world();
    await setPoints(w, 'a', 290);
    await w.svc.applyRace('a', race(1)); // +30 → 320 ≥ 300
    let v = await w.svc.promotion('a');
    expect(v.series).toMatchObject({ id: '2026-11:C:1', status: 'active', pips: ['open', 'open', 'open'], next: 1, tops: 0 });
    expect(v).toMatchObject({ classId: 'C', toClassId: 'B', line: 300, points: 320 });
    await w.svc.applyRace('a', race(3));
    v = await w.svc.promotion('a');
    expect(v.series).toMatchObject({ pips: ['top', 'open', 'open'], next: 2 });
    await w.svc.applyRace('a', race(2));
    v = await w.svc.promotion('a');
    expect(v.series).toMatchObject({ status: 'passed', pips: ['top', 'top', 'skip'], next: null, seen: false, setbackTo: null });
    expect(v.passedThisSeason).toBe(true);
    expect(promoKpi(w)).toEqual([['promo_series_start', 'C', 'B', '2026-11:C:1'], ['promo_series_end', 'pass', 'C', 'B']]);
    // passed: no second series, no setback, even after more races
    for (const p of [9, 10, 11]) await w.svc.applyRace('a', race(p));
    expect((await w.svc.promotion('a')).series!.id).toBe('2026-11:C:1');
    expect(promoKpi(w)).toHaveLength(2);
  });

  it('two misses fail it: points go back to line − setback; reaching the line again starts attempt 2', async () => {
    const w = world();
    await setPoints(w, 'a', 295);
    await w.svc.applyRace('a', race(2)); // 315
    await w.svc.applyRace('a', race(4)); // 327
    await w.svc.applyRace('a', race(12)); // 328 → fail
    const s = await st(w, 'a');
    expect(s.season.points).toBe(260);
    expect(seasonPointsEarned(s)).toBe(328);
    const v = await w.svc.promotion('a');
    expect(v.series).toMatchObject({ status: 'failed', pips: ['miss', 'miss', 'skip'], setbackTo: 260 });
    expect(v.earned).toBe(328);
    // the season mission 「昇級ラインに届く」 stays reached (REQ-PROMO-012)
    const sm = (await w.svc.missionsAll('a')) as unknown as { season: { missions: { id: string; claimable: boolean; progress: number }[] } };
    expect(sm.season.missions.find((x) => x.id === 'sm_promotion')).toMatchObject({ claimable: true, progress: 300 });
    await w.svc.applyRace('a', race(1)); // 290
    await w.svc.applyRace('a', race(2)); // 310 → attempt 2
    expect((await w.svc.promotion('a')).series).toMatchObject({ id: '2026-11:C:2', status: 'active' });
    expect(promoKpi(w).map((x) => x[0] + ':' + x[1])).toEqual(['promo_series_start:C', 'promo_series_end:fail', 'promo_series_start:C']);
  });

  it('a race the CPU finished after a disconnect is a miss whatever the place (points as usual)', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    await w.svc.applyRace('a', race(5)); // starts
    await w.svc.applyRace('a', race(1, { cpu: true }));
    const v = await w.svc.promotion('a');
    expect(v.series!.results[0]).toMatchObject({ place: 1, top: false, cpu: true });
    expect(v.points).toBe(300 + 10 + 30);
  });

  it('void, suspect, quarantined and non-ranked results do not count; one count per race id', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    await w.svc.applyRace('a', race(5)); // starts
    await w.svc.applyRace('a', race(0, { void: true }));
    await w.svc.applyRace('a', race(1, { suspect: true }));
    await w.svc.applyRace('a', race(1, { mode: 'friend', humans: 2 }));
    expect((await w.svc.promotion('a')).series!.results).toHaveLength(0);
    const dup = race(1);
    await w.svc.applyRace('a', dup);
    await w.svc.applyRace('a', dup); // delivered twice
    expect((await w.svc.promotion('a')).series!.results.map((x) => x.raceId)).toEqual([dup.raceId]);
    await w.svc.tx('a', null, (s) => { s.moderation = { status: 'quarantined', until: null, reason: 'x', at: NOV }; });
    await w.svc.applyRace('a', race(1));
    expect((await w.svc.promotion('a')).series!.results).toHaveLength(1);
  });

  it('a race that started before the series began is not part of it (late delivery); the order of arrival does not matter', () => {
    const s = freshPlayer('a', NOV);
    s.season.points = 300;
    const early = race(1);
    const starter = race(5);
    notePromotionRace(m, s, starter, NOV);
    expect(s.promotion!.series!.afterStartAtMs).toBe(starter.startAtMs);
    notePromotionRace(m, s, early, NOV); // started before the starter, delivered after it
    expect(s.promotion!.series!.results).toHaveLength(0);
    const later = race(2);
    notePromotionRace(m, s, later, NOV);
    notePromotionRace(m, s, later, NOV); // the same race id again
    expect(s.promotion!.series!.results.map((x) => x.raceId)).toEqual([later.raceId]);
  });

  it('a series keeps the rules it started with', () => {
    const s = freshPlayer('a', NOV);
    s.season.points = 300;
    notePromotionRace(m, s, race(5), NOV);
    const m5 = withRules({ races: 5, needTop: 4 });
    notePromotionRace(m5, s, race(1), NOV);
    notePromotionRace(m5, s, race(2), NOV);
    expect(s.promotion!.series).toMatchObject({ races: 3, needTop: 2, status: 'passed' });
  });

  it('no series in the top class (no line); ratings, coins and items are the same with the feature on or off', async () => {
    const on = world();
    const off = world(OFF);
    for (const w of [on, off]) {
      await w.svc.tx('a', null, (s) => { s.season.points = 300; s.flags.tutorialGachaUsed = true; });
      for (const p of [1, 2, 3, 12]) {
        const r = race(p, { newRating: { r: 1600 + p, rd: 100, vol: 0.06 }, oldRating: null });
        r.raceId = `same_${p}`; r.startAtMs = NOV + p;
        await w.svc.applyRace('a', r);
      }
    }
    const [a, b] = [await st(on, 'a'), await st(off, 'a')];
    expect(a.rating).toEqual(b.rating);
    expect(a.wallet).toEqual(b.wallet);
    expect(a.items).toEqual(b.items);
    const s = freshPlayer('t', NOV);
    s.season.classId = 'S';
    s.season.points = 900;
    expect(notePromotionRace(m, s, race(1), NOV).started).toBeNull();
  });
});

describe('season close (REQ-PROMO-008/009) and the grace window / shield (REQ-PROMO-010/011)', () => {
  it('a passed series promotes at the close with promo "series", an activity entry and the recap line', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    for (const p of [5, 1, 1]) await w.svc.applyRace('a', race(p));
    w.clock.now = DEC;
    await w.svc.tx('a', null, () => {});
    const s = await st(w, 'a');
    expect(s.season.classId).toBe('B');
    expect(s.seasonHistory.at(-1)).toMatchObject({ classId: 'C', nextClassId: 'B', promo: 'series' });
    expect(s.promotion!.grace).toEqual({ classId: 'B', races: 0, since: '2026-11' });
    expect(s.promotion!.series).toBeNull();
    expect(s.promotion!.history[0]!.status).toBe('passed');
    const act = await w.svc.activity('a');
    const item = (act as unknown as { items: { kind: string; vars: Record<string, string>; link: { screen: string; id: string | null } }[] }).items.find((x) => x.kind === 'class_promoted')!;
    expect(item.link).toEqual({ screen: 'recap', id: 'season:2026-11' });
    expect(activityText('class_promoted', 1, item.vars, '')).toBe('昇級戦を突破してB級に昇級しました');
    expect((await w.svc.promotion('a')).grace).toEqual({ classId: 'B', racesLeft: 10 });
    const recap = await w.svc.recap('a', 'season:2026-11');
    const rank = (recap as unknown as { steps: { key: string; notes: string[]; moments?: { text: string }[] }[] }).steps;
    expect(rank.find((x) => x.key === 'rank')!.notes).toContain('昇級戦を突破');
    expect(JSON.stringify(rank)).toContain('昇級戦を突破してB級へ昇格');
  });

  it('a series still running at the close is resolved by the points (season_end) and does not carry over', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    await w.svc.applyRace('a', race(5)); // starts
    await w.svc.applyRace('a', race(12)); // one miss
    w.clock.now = DEC;
    await w.svc.tx('a', null, () => {});
    const s = await st(w, 'a');
    expect(s.season.classId).toBe('B');
    expect(s.seasonHistory.at(-1)).toMatchObject({ promo: 'series_open' });
    expect(s.promotion!.history[0]).toMatchObject({ status: 'season_end' });
    expect(promoKpi(w).at(-1)).toEqual(['promo_series_end', 'season_end', 'C', 'B']);
    expect((await w.svc.promotion('a')).series).toBeNull();
    const act = (await w.svc.activity('a')) as unknown as { items: { kind: string; vars: Record<string, string> }[] };
    expect(activityText('class_promoted', 1, act.items.find((x) => x.kind === 'class_promoted')!.vars, '')).toBe('C級からB級に昇級しました');
  });

  it('the shield keeps the class once inside the grace window, then demotion works as before', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    for (const p of [5, 1, 1]) await w.svc.applyRace('a', race(p));
    w.clock.now = DEC;
    await w.svc.applyRace('a', race(12)); // B, 1 pt (< 50): one grace race
    w.clock.now = JAN;
    await w.svc.tx('a', null, () => {});
    let s = await st(w, 'a');
    expect(s.season.classId).toBe('B');
    expect(s.seasonHistory.at(-1)).toMatchObject({ seasonId: '2026-12', classId: 'B', nextClassId: 'B', shielded: true });
    expect(s.promotion!.shields).toEqual([{ seasonId: '2026-12', classId: 'B', at: JAN }]);
    expect(s.promotion!.grace).toBeNull();
    expect(promoKpi(w).at(-1)).toEqual(['demotion_shield_used', 'B', '2026-12', null]);
    expect(w.kpi.find((r) => r.name === 'demotion_shield_used')).toMatchObject({ count: 1, value: 1 });
    w.clock.now = FEB;
    await w.svc.tx('a', null, () => {});
    s = await st(w, 'a');
    expect(s.season.classId).toBe('C'); // no second shield
  });

  it('the grace window ends after graceRaces counted races', () => {
    const s = freshPlayer('a', NOV);
    s.season.points = 320;
    rollSeason(m, s, DEC); // C → B with a grace window (no series involved: the line was reached while the switch was off)
    expect(s.promotion!.grace).toEqual({ classId: 'B', races: 0, since: '2026-11' });
    expect(s.seasonHistory.at(-1)!.promo).toBeUndefined();
    const s1 = freshPlayer('c', NOV);
    rollSeason(m, s1, DEC); // nothing happened: no state
    expect(s1.promotion).toBeUndefined();
    const s2 = freshPlayer('b', NOV);
    s2.season.points = 300;
    notePromotionRace(m, s2, race(5), NOV);
    rollSeason(m, s2, DEC);
    expect(s2.promotion!.grace).toMatchObject({ classId: 'B', races: 0 });
    for (let i = 0; i < 10; i++) notePromotionRace(m, s2, race(12, { startAtMs: DEC + i }), DEC);
    expect(s2.promotion!.grace).toBeNull();
    rollSeason(m, s2, JAN);
    expect(s2.season.classId).toBe('C');
  });

  it('kill switch: no series, no shield, promotion at the close as before; the view shows nothing', async () => {
    const w = world(OFF);
    await setPoints(w, 'a', 300);
    for (const p of [12, 12, 12]) await w.svc.applyRace('a', race(p));
    expect((await st(w, 'a')).season.points).toBe(303);
    const v = await w.svc.promotion('a');
    expect(v).toMatchObject({ enabled: false, series: null, grace: null });
    w.clock.now = DEC;
    await w.svc.tx('a', null, () => {});
    expect((await st(w, 'a')).season.classId).toBe('B');
    w.clock.now = JAN;
    await w.svc.tx('a', null, () => {});
    expect((await st(w, 'a')).season.classId).toBe('C');
    expect(promoKpi(w)).toEqual([]);
    const act = (await w.svc.activity('a')) as unknown as { items: { kind: string }[] };
    expect(act.items.some((x) => x.kind === 'class_promoted')).toBe(false);
  });

  it('closePromotionSeason without state is a no-op', () => {
    const s = freshPlayer();
    expect(closePromotionSeason(m, s, '2026-11', 'C', 'B', false, DEC)).toEqual({ shielded: false, ended: null });
  });
});

describe('view, ack, tombstones (REQ-PROMO-013/014)', () => {
  it('ack marks an ended series seen (idempotent); unknown or active ids are NOT_FOUND', async () => {
    const w = world();
    await setPoints(w, 'a', 300);
    await w.svc.applyRace('a', race(5));
    expect(await code(w.svc.promotionAck('a', '2026-11:C:1'))).toBe('NOT_FOUND'); // still active
    for (const p of [1, 1]) await w.svc.applyRace('a', race(p));
    expect(await w.svc.promotionAck('a', '2026-11:C:1')).toEqual({ seriesId: '2026-11:C:1', seen: true });
    expect(await w.svc.promotionAck('a', '2026-11:C:1')).toEqual({ seriesId: '2026-11:C:1', seen: true });
    expect((await w.svc.promotion('a')).series!.seen).toBe(true);
    expect(await code(w.svc.promotionAck('a', '2026-11:C:9'))).toBe('NOT_FOUND');
    expect(await code(() => ackPromotion(freshPlayer(), 'x'))).toBe('NOT_FOUND');
  });
  it('a result for a deleted (tombstoned) account changes nothing', async () => {
    const w = world();
    w.repo.tombstones.add('gone');
    expect(await w.svc.applyRace('gone', race(1))).toMatchObject({ skipped: 'deleted' });
    expect(w.repo.get('gone')).toBeNull();
  });
  it('the view on a fresh player', () => {
    expect(promotionView(m, freshPlayer())).toMatchObject({ enabled: true, series: null, grace: null, passedThisSeason: false, line: 300, toClassId: 'B' });
  });
});

describe('classification and wiring (REQ-PROMO-014..018)', () => {
  it('KPI names are optional (§58); state key `promotion` is play (§51); routes are core (§46.2)', () => {
    for (const n of ['promo_series_start', 'promo_series_end', 'demotion_shield_used']) expect(kpiClassOf(n)).toBe('optional');
    expect(classifyKey('promotion')).toEqual({ section: 'play' });
    expect(endpointGroup('/v1/promotion')).toBe('core');
    expect(endpointGroup('/v1/promotion/ack')).toBe('core');
    expect(isExempt('GET', '/v1/promotion')).toBe(false);
  });
  it('activity kind class_promoted: season category, recap link, English, KPI kind list', () => {
    expect(ACTIVITY_KINDS).toContain('class_promoted');
    expect(ACTIVITY_META.class_promoted).toEqual({ category: 'season', screen: 'recap', collapse: false });
    expect(activityText('class_promoted', 1, { from: 'C', to: 'B', via: 'line' }, '')).toBe('C級からB級に昇級しました');
    expect(KPI_ACTIVITY_KINDS_FOR_TEST).toContain('class_promoted');
  });
  it('the help article fills its numbers from the rules; the tip links to it', () => {
    const a = m.help.articles.find((x) => x.id === 'promotion_series')!;
    const ja = fillTokens({ m, maxWhips: 3 }, a.body.ja);
    expect(ja).toContain('3戦のうち、3着以内が2回で突破');
    expect(ja).toContain('40ポイント手前');
    expect(fillTokens({ m: withRules({ races: 5, needTop: 3 }), maxWhips: 3 }, a.body.en)).toContain('Of the next 5 races');
    const tip = m.tips.tips.find((x) => x.id === 'promotion_series_tip')!;
    expect(tip).toMatchObject({ topic: 'race', help: 'promotion_series', unlock: 'season' });
  });
});
