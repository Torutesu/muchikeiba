import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import { clientBatchSchema, type KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import type { RaceMode } from '../src/domain/schemas.js';
import type { Style } from '../src/domain/master.js';
import {
  DEFAULT_SEASON_RECAP, SEASON_RECAP_LIMITS, gameYearOf, noteRecapReplaySaved, noteRecapRival, noteRecapTeamGoal, periodBounds, seasonRecapProblems,
  type SeasonRecapConfig,
} from '../src/domain/seasonRecap.js';
import { catalogFor, localize, untranslated, PLAYER_TEXT_KEYS, enWordingProblems } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-05 12:00 JST. */
const T0 = Date.UTC(2026, 10, 5, 3);
/** JST wall clock → ms. */
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const cfg = m.progression.seasonRecap as SeasonRecapConfig;
const withCfg = (patch: Partial<SeasonRecapConfig>, base: Master = m): Master => ({ ...base, progression: { ...base.progression, seasonRecap: { ...cfg, ...patch } } as Master['progression'] });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

function world(master: Master = m, start = T0) {
  let now = start;
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0;
  let raceSeq = 0;
  const k = () => `c:t:${n++}`;
  const player = async (id: string) => { await svc.bootstrap(id); await svc.grantPartner(id, 'アイボウ', k()); return (await svc.state(id)).flags.partnerHorseId!; };
  const race = async (id: string, place: number, o: { horseId?: string; style?: Style; trackId?: string; fieldSize?: number; mode?: RaceMode; humans?: number; void?: boolean; raceId?: string } = {}) => {
    const r: RaceResultForPlayer = {
      raceId: o.raceId ?? `r${raceSeq++}`, mode: o.mode ?? 'ranked', place, fieldSize: o.fieldSize ?? 12, newRating: null, void: o.void ?? false, humans: o.humans ?? 2,
      details: { trackId: o.trackId ?? 'aoba_turf_1600', style: o.style ?? 'sashi', finishTick: null, startReactionTicks: null, whips: 0, whipMashed: false, cpuAssisted: false },
      ...(o.horseId ? { horseId: o.horseId } : {}),
    };
    return svc.applyRace(id, r);
  };
  return { svc, repo, kpi, k, player, race, now: () => now, set: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; } };
}

describe('REQ-RECAP-013 config', () => {
  it('the shipped config is valid and the ranges are enforced', () => {
    expect(seasonRecapProblems(m)).toEqual([]);
    expect(cfg).toMatchObject({ enabled: true });
    expect(seasonRecapProblems(withCfg({ keepSeasons: 0 }))).toEqual(['progression.seasonRecap.keepSeasons: must be 1..24']);
    expect(seasonRecapProblems(withCfg({ keepSeasons: SEASON_RECAP_LIMITS.keepSeasons + 1 }))[0]).toContain('keepSeasons');
    expect(seasonRecapProblems(withCfg({ keepYears: 11 }))[0]).toContain('keepYears');
    expect(seasonRecapProblems(withCfg({ shortBelowRaces: 0 }))[0]).toContain('shortBelowRaces');
    expect(seasonRecapProblems(withCfg({ momentsMax: 1 }))[0]).toContain('momentsMax: must be 2..3');
    expect(seasonRecapProblems(withCfg({ momentsMax: 4 }))[0]).toContain('momentsMax');
    expect(seasonRecapProblems(withCfg({ extra: 1 } as never)).length).toBe(1);
    expect(seasonRecapProblems(withCfg({ keepYears: 1.5 }))[0]).toContain('keepYears');
    expect(DEFAULT_SEASON_RECAP.momentsMax).toBeLessThanOrEqual(3);
  });
});

describe('REQ-RECAP-003 periods', () => {
  it('the season is the JST month; the game year rolls over at 04:00 JST on 1 January', () => {
    expect(periodBounds(m, 'season', '2026-11')).toEqual({ from: jst(2026, 11, 1, 0), to: jst(2026, 12, 1, 0) });
    expect(periodBounds(m, 'season', '2027-01')).toEqual({ from: jst(2027, 1, 1, 0), to: jst(2027, 2, 1, 0) });
    expect(gameYearOf(m, jst(2027, 1, 1, 3, 59))).toBe('2026');
    expect(gameYearOf(m, jst(2027, 1, 1, 4, 0))).toBe('2027');
    expect(periodBounds(m, 'year', '2027')).toEqual({ from: jst(2027, 1, 1, 4), to: jst(2028, 1, 1, 4) });
  });
});

describe('REQ-RECAP-001/002/007 season recap', () => {
  it('counts confirmed races only, and the next transaction of the new month builds one snapshot from them', async () => {
    const w = world();
    const horse = await w.player('u');
    await w.race('u', 3, { horseId: horse, style: 'sashi' });
    await w.race('u', 1, { horseId: horse, style: 'sashi', trackId: 'kirameki_turf_2000' });
    await w.race('u', 1, { horseId: horse, style: 'senko', fieldSize: 12 });
    await w.race('u', 5, { style: 'sashi' }); // no horse id (older room): counted, not per horse
    // not counted: void, tutorial, time attack, a friend race with one human, the same race twice
    await w.race('u', 1, { void: true });
    await w.race('u', 1, { mode: 'tutorial' });
    await w.race('u', 1, { mode: 'timeattack' });
    await w.race('u', 1, { mode: 'friend', humans: 1 });
    await w.race('u', 2, { raceId: 'dup' });
    await w.race('u', 2, { raceId: 'dup' });
    expect((await w.svc.recaps('u')).recaps).toEqual([]);
    w.set(jst(2026, 12, 1, 0, 5));
    const list = await w.svc.recaps('u');
    expect(list.recaps.map((r) => r.id)).toEqual(['season:2026-11']);
    expect(list.unseen).toBe('season:2026-11');
    const s = await w.svc.state('u');
    const snap = s.seasonRecap!.recaps[0]!;
    expect(snap).toMatchObject({ races: 5, wins: 2, top3: 4, short: false, since: null, bestFinish: { place: 1, fieldSize: 12 } });
    expect(snap.horse).toMatchObject({ horseId: horse, horseName: 'アイボウ', races: 3, wins: 2 });
    expect(snap.style).toEqual({ style: 'sashi', races: 4 });
    expect(snap.moments.map((x) => x.kind)).toEqual(['first_win', 'streak']); // the biggest win is the first win: not shown twice
    expect(snap.moments[0]).toMatchObject({ kind: 'first_win', horseName: 'アイボウ', trackId: 'kirameki_turf_2000' });
    expect(JSON.stringify(snap).length).toBeLessThan(2048); // REQ-RECAP-009
    // the new season's record started fresh, for the whole period
    expect(s.seasonRecap!.acc.season).toMatchObject({ periodId: '2026-12', races: 0, since: jst(2026, 12, 1, 0) });
  });

  it('is built once per player per season, whatever retries and the rollover job do; the final rank is written once', async () => {
    const w = world();
    const horse = await w.player('u');
    for (let i = 0; i < 4; i++) await w.race('u', 2, { horseId: horse });
    w.set(jst(2026, 12, 1, 0, 30));
    const a = await w.svc.closeSeason('u', '2026-11', 7);
    await w.svc.closeSeason('u', '2026-11', 99); // a retry of the job
    await w.svc.recaps('u');
    await w.svc.recaps('u');
    const s = await w.svc.state('u');
    expect(a.status).toBe('rewarded');
    expect(s.seasonRecap!.recaps.filter((r) => r.id === 'season:2026-11')).toHaveLength(1);
    expect(s.seasonRecap!.recaps[0]!.rank).toMatchObject({ classId: 'C', finalRank: 7, promoted: false, seasonId: '2026-11' });
    const v = await w.svc.recap('u', 'season:2026-11');
    const rank = v.steps.find((x) => x.key === 'rank')!;
    expect(rank).toMatchObject({ value: 'C級', notes: ['最終順位 7位'] });
  });

  it('promotion is the first moment and the rank line shows the class reached', async () => {
    // the line alone promotes here (§68 promotion series off: the old rule); the series case is in promotion.test.ts
    const w = world({ ...m, progression: { ...m.progression, promotion: { ...m.progression.promotion!, enabled: false } } });
    const horse = await w.player('u');
    const s0 = await w.svc.state('u');
    s0.season.points = 400; // C promotes at 300
    await w.repo.put(s0);
    for (let i = 0; i < 3; i++) await w.race('u', 4, { horseId: horse });
    w.set(jst(2026, 12, 1, 1));
    await w.svc.closeSeason('u', '2026-11', 3);
    const v = await w.svc.recap('u', 'season:2026-11');
    expect(v.steps.find((x) => x.key === 'rank')).toMatchObject({ value: 'B級', notes: ['最終順位 3位', 'C級からB級へ昇格'] });
    expect(v.steps.find((x) => x.key === 'moments')!.moments![0]).toMatchObject({ kind: 'promotion', text: 'C級からB級へ昇格' });
    expect(v.shareCards.find((c) => c.card === 'rank')).toMatchObject({ rank: true, headline: 'B級' });
    // the promotion is the only moment here: its card counts as a rank card (hidden with 「順位を隠す」)
    expect(v.shareCards.find((c) => c.card === 'moment')).toMatchObject({ rank: true, lines: ['名場面', 'C級からB級へ昇格'] });
  });

  it('a period with no activity has no recap; a little activity gets the short version (never an empty one)', async () => {
    const w = world();
    const horse = await w.player('u');
    await w.player('idle');
    await w.race('u', 6, { horseId: horse });
    w.set(jst(2026, 12, 2));
    expect((await w.svc.recaps('idle')).recaps).toEqual([]);
    const v = await w.svc.recap('u', 'season:2026-11');
    expect(v.short).toBe(true);
    expect(v.steps.map((x) => x.key)).toEqual(['races', 'best_finish', 'horse', 'end']);
    expect(v.steps.at(-1)!.label).toBe('次のシーズンも、あなたのペースで。');
    expect(v.shareCards.map((c) => c.card)).toEqual(['summary', 'horse']);
  });

  it('REQ-RECAP-006: a record that began mid-season says "since"; the next one covers the whole period', async () => {
    const w = world(m, jst(2026, 10, 20));
    const horse = await w.player('old');
    // the player existed before the feature: drop the record the bootstrap started, as if it shipped on 11-09
    const s0 = await w.svc.state('old');
    delete s0.seasonRecap;
    await w.repo.put(s0);
    w.set(jst(2026, 11, 9, 15));
    for (let i = 0; i < 3; i++) await w.race('old', 1, { horseId: horse });
    w.set(jst(2026, 12, 1, 9));
    for (let i = 0; i < 3; i++) await w.race('old', 2, { horseId: horse });
    const v = await w.svc.recap('old', 'season:2026-11');
    expect(v.sinceNote).toBe('2026-11-09からの記録です');
    w.set(jst(2027, 1, 1, 9));
    const d = await w.svc.recap('old', 'season:2026-12');
    expect(d.sinceNote).toBeNull();
    // the year record started on 11-09 too
    w.set(jst(2027, 1, 1, 5));
    const y = await w.svc.recap('old', 'year:2026');
    expect(y.sinceNote).toBe('2026-11-09からの記録です');
  });
});

describe('REQ-RECAP-003 year recap', () => {
  it('closes at 04:00 JST on 1 January (game day), after the December season closed at midnight', async () => {
    const w = world(m, jst(2026, 12, 10));
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 1, { horseId: horse, fieldSize: 10 });
    w.set(jst(2027, 1, 1, 2)); // a race between 00:00 and 04:00: new season, previous game year
    await w.race('u', 2, { horseId: horse });
    let ids = (await w.svc.recaps('u')).recaps.map((r) => r.id);
    expect(ids).toEqual(['season:2026-12']);
    w.set(jst(2027, 1, 1, 4));
    ids = (await w.svc.recaps('u')).recaps.map((r) => r.id);
    expect(ids).toEqual(['year:2026', 'season:2026-12']);
    const s = await w.svc.state('u');
    const year = s.seasonRecap!.recaps.find((r) => r.id === 'year:2026')!;
    expect(year).toMatchObject({ races: 4, wins: 3, kind: 'year' });
    expect(year.moments.map((x) => x.kind)).toEqual(['first_win', 'streak']);
    expect((await w.svc.recap('u', 'year:2026')).title).toBe('2026年の振り返り');
  });
});

describe('REQ-RECAP-006/007 sources read by period, and the hooks', () => {
  it('time attack, hall, rival, team goal and replay saves', async () => {
    const w = world();
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 2, { horseId: horse });
    const s = await w.svc.state('u');
    s.timeAttack = {
      sessions: [], daily: { date: '', count: 0 }, milestones: [],
      seasonBest: {
        '2026-11:aoba_turf_1600': { timeMs: 95_400, finishTick: 1, finishFrac: 0, sessionId: 's1', horseId: horse, horseName: 'アイボウ', at: T0 },
        '2026-11:kirameki_turf_2000': { timeMs: 121_000, finishTick: 1, finishFrac: 0, sessionId: 's2', horseId: horse, horseName: 'アイボウ', at: T0 + HOUR },
        '2026-10:aoba_turf_1600': { timeMs: 94_000, finishTick: 1, finishFrac: 0, sessionId: 's0', horseId: horse, horseName: 'アイボウ', at: T0 - 30 * DAY },
      },
      allTimeBest: { aoba_turf_1600: { timeMs: 94_000, finishTick: 1, finishFrac: 0, sessionId: 's0', horseId: horse, horseName: 'アイボウ', at: T0 - 30 * DAY },
        kirameki_turf_2000: { timeMs: 121_000, finishTick: 1, finishFrac: 0, sessionId: 's2', horseId: horse, horseName: 'アイボウ', at: T0 + HOUR } },
    };
    s.hall = { careers: {}, ceremonies: {}, visibility: 'friends_team', rewarded: true, entries: [
      { horseId: 'h-old', horseName: 'ムカシノメイバ', rarity: 'R', sex: 'male', appearance: s.horses[0]!.appearance!, partner: false, reasons: ['wins'], inductedAt: T0 - 40 * DAY, career: { races: 1, wins: 1, places: 1, tournamentWins: 0, firstRaceAt: null, lastRaceAt: null }, highlights: [] },
      { horseId: 'h-new', horseName: 'デンドウイリ', rarity: 'SR', sex: 'female', appearance: s.horses[0]!.appearance!, partner: false, reasons: ['wins'], inductedAt: T0 + 2 * DAY, career: { races: 1, wins: 1, places: 1, tournamentWins: 0, firstRaceAt: null, lastRaceAt: null }, highlights: [] },
    ] };
    noteRecapRival(m, s, 'win', T0); noteRecapRival(m, s, 'lose', T0); noteRecapRival(m, s, 'not_enough', T0); noteRecapRival(m, s, 'no_contest', T0);
    noteRecapTeamGoal(m, s, { races: 1, wins: 1, taPb: 0 }, T0); noteRecapTeamGoal(m, s, null, T0);
    noteRecapReplaySaved(m, s, T0);
    await w.repo.put(s);
    w.set(jst(2026, 12, 1, 1));
    const v = await w.svc.recap('u', 'season:2026-11');
    const step = (k: string) => v.steps.find((x) => x.key === k);
    // the course record set this season wins over a newer non-record; course times are never compared
    expect(step('time_attack')).toMatchObject({ value: '2:01.0', horseName: 'アイボウ', notes: ['きらめき競馬場 芝2000m', 'このコースの自己ベスト'] });
    expect(step('hall')).toMatchObject({ value: '1', horses: [{ horseName: 'デンドウイリ' }] });
    expect(step('rival')).toMatchObject({ value: '1勝1敗0分' });
    expect(step('team')).toMatchObject({ value: '2' });
    expect(step('replays')).toMatchObject({ value: '1' });
    expect(step('moments')!.moments!.map((x) => x.kind)).toEqual(['hall', 'ta_best']);
  });

  it('the real hooks: a saved replay counts once (commitSave), a settled rival week, the team goal count', async () => {
    // wired in service.ts / rival.ts — checked here by source so a refactor that drops a hook fails loudly
    const { readFileSync } = await import('node:fs');
    const src = (f: string) => readFileSync(`src/domain/${f}`, 'utf8'); // vitest runs in server/
    const svc = src('service.ts');
    const rival = src('rival.ts');
    expect(svc).toMatch(/if \(!r\.alreadySaved\) noteRecapReplaySaved/);
    expect(svc.match(/noteRecapTeamGoal\(this\.d\.master, s, goal, now\)/g)).toHaveLength(2);
    expect(svc).toMatch(/noteRecapRace\(this\.d\.master, s, r, now\)/);
    expect(svc).toMatch(/const rolled = rollSeason\(this\.d\.master, draft, now\);\n[\s\S]{0,1200}?\n[^\n]*\n\s+for \(const rid of rollRecaps\(this\.d\.master, draft, now\)\)/); // + the §68 class_promoted entry (Round 22) // + the recap_ready activity entry (Round 16 integration)
    expect(rival).toMatch(/noteRecapRival\(m, s, outcome, now\)/);
  });
});

describe('REQ-RECAP-006 switched off and on again', () => {
  it('a gap in the records is never covered up: the records start again from the day it came back', async () => {
    const off = withCfg({ enabled: false });
    const repo = new MemoryPlayerRepo();
    let now = jst(2026, 11, 2);
    const on = new PlayerService(repo, { master: m, rng: seededRng(1), clock: () => now, verifiers: {} });
    const offSvc = new PlayerService(repo, { master: off, rng: seededRng(1), clock: () => now, verifiers: {} });
    await on.bootstrap('u'); await on.grantPartner('u', 'アイボウ', 'c:1');
    const horse = (await on.state('u')).flags.partnerHorseId!;
    const race = (svc: PlayerService, id: string) => svc.applyRace('u', { raceId: id, mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 2, horseId: horse });
    now = jst(2026, 11, 20, 13); await race(on, 'a');
    expect((await on.state('u')).seasonRecap!.paused).toBeUndefined();
    now = jst(2026, 11, 21); await race(offSvc, 'b'); // switched off: not recorded
    expect((await offSvc.state('u')).seasonRecap!.paused).toBe(true);
    now = jst(2026, 11, 25); await race(on, 'c');
    now = jst(2026, 12, 1, 9);
    const v = await on.recap('u', 'season:2026-11');
    expect(v.steps[0]!.value).toBe('1'); // only the race after it came back
    expect(v.sinceNote).toBe('2026-11-25からの記録です');
  });
});

describe('REQ-RECAP-009 keep', () => {
  it('keeps the newest keepSeasons season recaps', async () => {
    const w = world(withCfg({ keepSeasons: 2 }), jst(2026, 9, 3));
    const horse = await w.player('u');
    for (const [y, mo] of [[2026, 9], [2026, 10], [2026, 11], [2026, 12], [2027, 1]] as const) {
      w.set(jst(y, mo, 3));
      await w.race('u', 1, { horseId: horse });
    }
    const ids = (await w.svc.state('u')).seasonRecap!.recaps.filter((r) => r.kind === 'season').map((r) => r.id).sort();
    expect(ids).toEqual(['season:2026-11', 'season:2026-12']);
  });
});

describe('REQ-RECAP-010/015 progress and KPI', () => {
  it('keeps the first open / complete time and emits recap_open / recap_complete', async () => {
    const w = world();
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 1, { horseId: horse });
    w.set(jst(2026, 12, 1, 9));
    const a = await w.svc.recapProgress('u', 'season:2026-11', 'open');
    w.advance(60_000);
    const b = await w.svc.recapProgress('u', 'season:2026-11', 'open');
    expect(b.openedAt).toBe(a.openedAt);
    const c = await w.svc.recapProgress('u', 'season:2026-11', 'complete');
    expect(c.completedAt).toBe(w.now());
    expect((await w.svc.recaps('u')).unseen).toBeNull();
    const rows = w.kpi.filter((r) => r.name.startsWith('recap_'));
    expect(rows.map((r) => [r.name, r.isFirst, r.s1, r.s2, r.s3])).toEqual([
      ['recap_open', true, 'season', '2026-11', 'full'], ['recap_open', false, 'season', '2026-11', 'full'], ['recap_complete', true, 'season', '2026-11', 'full'],
    ]);
    expect(await code(w.svc.recapProgress('u', 'season:2020-01', 'open'))).toBe('NOT_FOUND');
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'recap_share', at: 1, props: { kind: 'season', card: 'rank', hideRank: false } }] }).success).toBe(true);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'recap_share', at: 1, props: { kind: 'season', card: 'coins', hideRank: false } }] }).success).toBe(false);
  });
});

describe('REQ-RECAP-011/012 wording, English, privacy', () => {
  const full = async () => {
    const w = world();
    const horse = await w.player('u');
    const s0 = await w.svc.state('u');
    s0.season.points = 400;
    s0.profile.displayName = 'ヒミツノキシュ';
    await w.repo.put(s0);
    for (let i = 0; i < 4; i++) await w.race('u', 1, { horseId: horse, fieldSize: 12 });
    await w.race('u', 3, { horseId: horse });
    w.set(jst(2026, 12, 1, 1));
    await w.svc.closeSeason('u', '2026-11', 2);
    return w.svc.recap('u', 'season:2026-11');
  };

  it('every line has English; horse names are never translated', async () => {
    const v = await full();
    const en = localize(v, 'en', catalogFor(m));
    expect(untranslated(en, PLAYER_TEXT_KEYS)).toEqual([]);
    expect(en.title).toBe('Season 11/2026');
    expect(en.steps.find((x) => x.key === 'horse')!.horseName).toBe('アイボウ');
    expect(en.steps.find((x) => x.key === 'best_finish')!.value).toBe('1st');
    expect(en.steps.find((x) => x.key === 'rank')!.notes).toEqual(['Final position: 2nd', 'Promoted from Class C to Class B', 'Won the promotion series']); // §68: the line was reached, then two wins passed the series
    expect(localize({ t: '2026-11-09からの記録です' }, 'en', catalogFor(m)).t).toBe('Recorded since 2026-11-09');
  });

  it('no betting words, no fake urgency, no spending; no player names or ids', async () => {
    const v = await full();
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/倍|お得|今だけ|残りわずか|賭|配当|オッズ|購入|課金|コイン|ガチャ/);
    expect(json).not.toContain('ヒミツノキシュ');
    expect(json).not.toContain('"u"');
    const recapKeys = Object.keys(CODE_EN).slice(Object.keys(CODE_EN).indexOf('{y}年{m}月シーズン'), Object.keys(CODE_EN).indexOf('タイムアタックの自己ベスト') + 1);
    expect(recapKeys.length).toBeGreaterThan(40);
    for (const k of recapKeys) {
      expect(k).not.toMatch(/倍|お得|今だけ|賭|配当|オッズ|購入|課金/);
      expect(enWordingProblems(CODE_EN[k]!)).toEqual([]);
      expect(CODE_EN[k]).not.toMatch(/\bbet|odds|payout|buy|purchase|coins?\b|limited|only now|\d+x\b/i);
    }
  });
});

describe('REQ-RECAP-014 account deletion', () => {
  it('the wipe removes the recaps; a late season close creates nothing; nothing is built while deleting', async () => {
    const w = world();
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 1, { horseId: horse });
    w.set(jst(2026, 12, 1, 1));
    await w.svc.recaps('u');
    expect((await w.svc.state('u')).seasonRecap!.recaps).toHaveLength(1);
    await w.svc.wipe('u');
    expect(await w.svc.closeSeason('u', '2026-11', 1)).toMatchObject({ status: 'no-record' });
    expect(w.repo.get('u')).toBeNull();

    const d = world();
    const h2 = await d.player('x');
    for (let i = 0; i < 3; i++) await d.race('x', 1, { horseId: h2 });
    const s = await d.svc.state('x');
    s.deletion = { status: 'deleting' } as never;
    await d.repo.put(s);
    d.set(jst(2026, 12, 1, 1));
    expect((await d.svc.recaps('x')).recaps).toEqual([]);
  });
});

describe('§43 HTTP', () => {
  it('routes, id validation, disabled', async () => {
    const w = world();
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 1, { horseId: horse });
    w.set(jst(2026, 12, 1, 9));
    const svc = w.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: w.now } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/recaps')).body).toMatchObject({ enabled: true, unseen: 'season:2026-11' });
    const en = await call('GET', '/v1/recaps/season:2026-11', undefined, { 'accept-language': 'en' });
    expect(en.status).toBe(200);
    expect(en.body.steps[0]).toMatchObject({ key: 'races', label: 'Races run', value: '3', unit: 'races' });
    expect((await call('GET', '/v1/recaps/season%3A2026-11')).status).toBe(200);
    expect((await call('GET', '/v1/recaps/nope')).status).toBe(404);
    expect((await call('GET', '/v1/recaps/season:1999-01')).status).toBe(404);
    expect((await call('POST', '/v1/recaps/season:2026-11/progress', { step: 'share' })).status).toBe(400);
    expect((await call('POST', '/v1/recaps/season:2026-11/progress', { step: 'open' })).body.openedAt).toBe(w.now());
    const off = { ...c, master: withCfg({ enabled: false }) } as AppContext;
    const offSvc = new PlayerService(w.repo, { master: withCfg({ enabled: false }), rng: seededRng(1), clock: w.now, verifiers: {} });
    expect(await offSvc.recaps('u')).toEqual({ enabled: false, recaps: [], unseen: null });
    expect(await code(offSvc.recap('u', 'season:2026-11'))).toBe('NOT_FOUND');
    void off;
  });
});
