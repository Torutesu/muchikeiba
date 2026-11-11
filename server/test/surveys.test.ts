/**
 * REQ-SURVEY-001..024 (contracts/protocol.md §69): ゲーム内アンケート. Definition rules (kinds, both languages, the wording
 * lint, reward keys), the config, targeting (incl. the stable sample), the offer order (FTUE, cool-down, one at a time, the
 * session placements), shown / skip / answer (strict validation, once per player, idempotent, closed / unknown / tombstone /
 * deletion), the free-text scrub, nothing granted, the analytics choice (no segment, KPI withheld), the ops store (draft →
 * publish → close, maxLive, results, CSV, hide), the player HTTP routes and the admin console API, deletion and the export.
 */
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import {
  SURVEYS_DEFAULTS, decideSurveyOffer, normalizeSurveyDef, sampleBucket, scrubFreeText, surveyDefProblems, surveysConfig, surveysProblems,
  validateSurveyAnswers, type LiveSurvey, type SurveyDef,
} from '../src/domain/surveys.js';
import { MemorySurveyRepo, SurveysCore, csvField } from '../src/ops/surveys.js';
import { classifyKey, buildExportDocument } from '../src/domain/dataExport.js';
import { endpointGroup } from '../src/domain/maintenance.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 11, 3);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CFG = surveysConfig(m);
const V = m.progression.consent!.privacyVersion;

export const SAMPLE: SurveyDef = {
  id: 'sv_whip_feel', title: { ja: 'ムチの手ごたえ', en: 'How the whip feels' }, intro: { ja: '1分で終わる質問です。', en: 'Takes about a minute.' },
  placements: ['home', 'result'], targeting: {},
  questions: [
    { id: 'feel', kind: 'scale', required: true, text: { ja: 'ムチを入れた時の手ごたえは？', en: 'How does the whip feel?' }, labels: { low: { ja: '弱い', en: 'Weak' }, high: { ja: '強い', en: 'Strong' } } },
    { id: 'mode', kind: 'single', required: true, text: { ja: 'いちばん遊ぶのは？', en: 'What do you play most?' }, options: [{ id: 'ranked', text: { ja: 'ランク戦', en: 'Ranked' } }, { id: 'events', text: { ja: 'イベント', en: 'Events' } }] },
    { id: 'wish', kind: 'multi', required: false, maxChoices: 2, text: { ja: '増えてほしいものは？', en: 'What would you like more of?' }, options: [{ id: 'tracks', text: { ja: 'コース', en: 'Tracks' } }, { id: 'events', text: { ja: 'イベント', en: 'Events' } }, { id: 'silks', text: { ja: '勝負服', en: 'Silks' } }] },
    { id: 'free', kind: 'text', required: false, maxLength: 200, text: { ja: 'ひとことあれば', en: 'Anything else?' } },
  ],
};
const def = (o: Partial<SurveyDef> = {}): SurveyDef => ({ ...structuredClone(SAMPLE), ...o });
const live = (d: SurveyDef = SAMPLE, o: Partial<LiveSurvey> = {}): LiveSurvey => ({ def: normalizeSurveyDef(d), rev: 1, startAt: NOW - DAY, endAt: NOW + 7 * DAY, ...o });
const GOOD = { feel: 4, mode: 'ranked', wish: ['events'], free: 'ムチの音がもっと欲しい' };

function world(master: Master = m) {
  const clock = { now: NOW };
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(9), clock: () => clock.now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  return { svc, clock, kpi, repo };
}
type W = ReturnType<typeof world>;
async function settled(w: W, id: string, o: (s: PlayerState) => void = () => {}) {
  await w.svc.tx(id, null, (s) => { s.createdAt = NOW - 20 * DAY; s.flags.tutorialGachaUsed = true; s.rating.rankedRaces = 30; o(s); });
}
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
let k = 0;
const key = () => `c:/v1/surveys/answers:k${++k}`;
const facts = { platform: 'ios', appVersion: '1.4.0' };

describe('定義の検査 (REQ-SURVEY-001/002)', () => {
  it('the sample is valid; kinds, both languages, counts and lengths are checked', () => {
    expect(surveyDefProblems(m, SAMPLE)).toEqual([]);
    expect(surveyDefProblems(m, def({ id: 'whip' }))[0]).toMatch(/survey.id/);
    expect(surveyDefProblems(m, def({ title: { ja: 'ムチ', en: '' } })).join()).toMatch(/title.en is required/);
    expect(surveyDefProblems(m, def({ title: { ja: 'あ'.repeat(41), en: 'x' } })).join()).toMatch(/longer than 40/);
    expect(surveyDefProblems(m, def({ questions: [] })).join()).toMatch(/1..5 questions/);
    expect(surveyDefProblems(m, def({ questions: Array.from({ length: 6 }, (_, i) => ({ ...SAMPLE.questions[0]!, id: `q${i}` })) })).join()).toMatch(/1..5 questions/);
    const q = (o: Record<string, unknown>) => def({ questions: [{ ...SAMPLE.questions[1]!, ...o } as never] });
    expect(surveyDefProblems(m, q({ options: [SAMPLE.questions[1]!.options![0]] })).join()).toMatch(/2..6 choices/);
    expect(surveyDefProblems(m, q({ kind: 'poll' })).join()).toMatch(/kind must be/);
    expect(surveyDefProblems(m, q({ maxLength: 10 })).join()).toMatch(/not used by a single question/);
    expect(surveyDefProblems(m, def({ questions: [{ ...SAMPLE.questions[3]!, required: true }] })).join()).toMatch(/always optional/);
    expect(surveyDefProblems(m, def({ questions: [{ ...SAMPLE.questions[3]!, maxLength: 201 }] })).join()).toMatch(/maxLength/);
    expect(surveyDefProblems(m, def({ questions: [SAMPLE.questions[0]!, SAMPLE.questions[0]!] })).join()).toMatch(/used twice/);
    expect(surveyDefProblems(m, def({ placements: ['race'] as never })).join()).toMatch(/unknown placement/);
  });
  it('betting words, pressure words, NG names and reward-like keys are refused (景表法: answers are never rewarded)', () => {
    expect(surveyDefProblems(m, def({ title: { ja: 'オッズの見方', en: 'Odds' } })).join()).toMatch(/betting words/);
    expect(surveyDefProblems(m, def({ intro: { ja: '今だけの質問', en: 'Only now' } })).join()).toMatch(/pressure wording/);
    expect(surveyDefProblems(m, def({ intro: { ja: 'x', en: 'place your bets' } })).join()).toMatch(/betting words/);
    const ng = m.ng.contains[0] ?? m.ng.exact[0]!;
    expect(surveyDefProblems(m, def({ title: { ja: ng, en: 'x' } })).join()).toMatch(/NG list/);
    expect(surveyDefProblems(m, { ...def(), reward: { coins: 10 } }).join()).toMatch(/never rewarded/);
    expect(surveyDefProblems(m, def({ targeting: { coins: 1 } as never })).join()).toMatch(/never rewarded/);
    expect(surveyDefProblems(m, { ...def(), extra: 1 }).join()).toMatch(/not a known key/);
  });
  it('targeting values are checked against the master (classes) and each other', () => {
    expect(surveyDefProblems(m, def({ targeting: { classes: ['Z9'] } })).join()).toMatch(/unknown class/);
    expect(surveyDefProblems(m, def({ targeting: { minDaysSinceInstall: 9, maxDaysSinceInstall: 3 } })).join()).toMatch(/min.*> max/);
    expect(surveyDefProblems(m, def({ targeting: { appVersion: { min: '2.0.0', max: '1.0.0' } } })).join()).toMatch(/min > max/);
    expect(surveyDefProblems(m, def({ targeting: { appVersion: { min: 'v2' } } })).join()).toMatch(/x.y.z/);
    expect(surveyDefProblems(m, def({ targeting: { samplePercent: 0 } })).join()).toMatch(/samplePercent/);
    expect(surveyDefProblems(m, def({ targeting: { platforms: ['ios', 'web'] as never } })).join()).toMatch(/unknown platform/);
    expect(surveyDefProblems(m, def({ targeting: { classes: [m.progression.classes[0]!.id], platforms: ['ios'], samplePercent: 50, minRankedRaces: 5 } }))).toEqual([]);
  });
});

describe('設定 progression.surveys (REQ-SURVEY-004)', () => {
  it('the shipped config is valid and read with defaults; bad values, unknown and reward keys fail', () => {
    expect(surveysProblems(m)).toEqual([]);
    expect(CFG).toEqual(SURVEYS_DEFAULTS);
    const w = (o: Record<string, unknown>) => surveysProblems({ progression: { ...m.progression, surveys: o } } as Master);
    expect(w({ coolDownHours: -1 })[0]).toMatch(/coolDownHours/);
    expect(w({ maxShowsPerSurvey: 9 })[0]).toMatch(/maxShowsPerSurvey/);
    expect(w({ textMax: 500 })[0]).toMatch(/textMax/);
    expect(w({ rewardCoins: 10 })[0]).toMatch(/not a known key/);
    expect(w({ reward: 10 })[0]).toMatch(/never rewarded/);
  });
});

describe('出す判断 (REQ-SURVEY-005/006)', () => {
  const s0 = () => { const w = world(); return w; };
  it('order: disabled → account_closing → ftue → current → cool_down → first open → none', async () => {
    const w = s0();
    const s = await st(w, 'p');
    const d = (o: { cfg?: typeof CFG; l?: LiveSurvey[]; st?: PlayerState; placement?: 'home' | 'result'; ftue?: boolean } = {}) =>
      decideSurveyOffer(o.cfg ?? CFG, o.l ?? [live()], o.st ?? s, { ...facts, inFtue: o.ftue }, o.placement ?? 'home', 'ja', NOW);
    expect(d().reason).toBe('ftue'); // a new player: free 10-pull not used
    s.flags.tutorialGachaUsed = true;
    expect(d().survey?.id).toBe('sv_whip_feel');
    expect(d({ ftue: true }).reason).toBe('ftue');
    expect(d({ cfg: { ...CFG, enabled: false } }).reason).toBe('disabled');
    s.deletion = { status: 'scheduled' } as never;
    expect(d().reason).toBe('account_closing');
    delete s.deletion;
    s.surveys = { v: 1, shows: {}, done: { sv_old: { at: NOW - HOUR, outcome: 'skipped', placement: 'home', title: { ja: 'a', en: 'a' } } }, current: null, lastDoneAt: NOW - HOUR };
    expect(d().reason).toBe('cool_down');
    s.surveys.current = 'sv_whip_feel'; // shown earlier, not answered: it continues whatever the cool-down
    expect(d().survey?.id).toBe('sv_whip_feel');
    s.surveys.lastDoneAt = NOW - 73 * HOUR; s.surveys.current = null;
    expect(d().survey?.id).toBe('sv_whip_feel');
    expect(d({ l: [live(def({ placements: ['result'] }))] }).reason).toBe('none');
    expect(d({ l: [live(SAMPLE, { startAt: NOW + HOUR })] }).reason).toBe('none'); // scheduled
    expect(d({ l: [] }).reason).toBe('none');
    s.surveys.shows.sv_whip_feel = { n: 2, firstAt: NOW, lastAt: NOW };
    expect(d().reason).toBe('none'); // maxShowsPerSurvey
  });
  it('one at a time: the earliest end first; the texts of one language only', async () => {
    const w = s0();
    await settled(w, 'p');
    const s = await st(w, 'p');
    const a = live(def({ id: 'sv_aaa' }), { endAt: NOW + 5 * DAY }), b = live(def({ id: 'sv_bbb' }), { endAt: NOW + 2 * DAY });
    const o = decideSurveyOffer(CFG, [a, b], s, facts, 'home', 'en', NOW);
    expect(o.survey?.id).toBe('sv_bbb');
    expect(o.survey?.title).toBe('How the whip feels');
    expect(JSON.stringify(o.survey)).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(o.survey?.questions.find((q) => q.id === 'wish')?.maxChoices).toBe(2);
  });
  it('targeting: ranked races, install days, platform, app version, class, stable sample', async () => {
    const w = s0();
    await settled(w, 'p');
    const s = await st(w, 'p');
    const t = (targeting: SurveyDef['targeting'], f = facts) => decideSurveyOffer(CFG, [live(def({ targeting }))], s, f, 'home', 'ja', NOW).survey !== null;
    expect(t({ minRankedRaces: 30 })).toBe(true);
    expect(t({ minRankedRaces: 31 })).toBe(false);
    expect(t({ minDaysSinceInstall: 21 })).toBe(false);
    expect(t({ maxDaysSinceInstall: 19 })).toBe(false);
    expect(t({ platforms: ['android'] })).toBe(false);
    expect(t({ platforms: ['ios'] }, { platform: null as never, appVersion: '1.0.0' })).toBe(false);
    expect(t({ appVersion: { min: '1.4.0', max: '1.4.9' } })).toBe(true);
    expect(t({ appVersion: { min: '1.5.0' } })).toBe(false);
    expect(t({ appVersion: { max: '1.3.9' } })).toBe(false);
    expect(t({ appVersion: { min: '1.0.0' } }, { platform: 'ios', appVersion: null as never })).toBe(false);
    expect(t({ classes: [s.season.classId] })).toBe(true);
    expect(t({ classes: ['ZZ'] })).toBe(false);
    const bucket = sampleBucket('sv_whip_feel', 'p');
    expect(bucket).toBe(sampleBucket('sv_whip_feel', 'p')); // stable
    expect(t({ samplePercent: bucket + 1 })).toBe(true);
    if (bucket > 0) expect(t({ samplePercent: bucket })).toBe(false);
    // roughly the asked share over many players
    const n = Array.from({ length: 2000 }, (_, i) => sampleBucket('sv_whip_feel', `p_${i}`)).filter((b) => b < 30).length;
    expect(n).toBeGreaterThan(500); expect(n).toBeLessThan(700);
  });
});

describe('答えの検査とスクラブ (REQ-SURVEY-009/012)', () => {
  const d = normalizeSurveyDef(SAMPLE);
  const bad = (a: unknown) => { try { validateSurveyAnswers(d, a, CFG); return 'ok'; } catch (e) { return (e as AppError).code; } };
  it('strict: unknown question, wrong types, unknown options, required, duplicates, too many, too long', () => {
    expect(validateSurveyAnswers(d, GOOD, CFG)).toEqual(GOOD);
    expect(bad({ ...GOOD, nope: 1 })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, feel: 6 })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, feel: 2.5 })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, feel: '4' })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, mode: 'cups' })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, mode: ['ranked'] })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, wish: ['events', 'events'] })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, wish: ['events', 'tracks', 'silks'] })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, wish: 'events' })).toBe('BAD_REQUEST');
    expect(bad({ feel: 3 })).toBe('BAD_REQUEST'); // mode is required
    expect(bad({ ...GOOD, free: 'あ'.repeat(201) })).toBe('BAD_REQUEST');
    expect(bad({ ...GOOD, free: 5 })).toBe('BAD_REQUEST');
    expect(bad([])).toBe('BAD_REQUEST');
    expect(validateSurveyAnswers(d, { feel: 1, mode: 'events', free: '   ', wish: [] }, CFG)).toEqual({ feel: 1, mode: 'events' });
    expect(validateSurveyAnswers(d, { feel: 1, mode: 'events', wish: ['silks', 'tracks'] }, CFG).wish).toEqual(['tracks', 'silks']); // definition order
  });
  it('free text: emails, URLs, tokens, long numbers and phone numbers go; Japanese stays; capped', () => {
    expect(scrubFreeText('連絡は taro@example.com か https://example.com/x まで', 200)).toBe('連絡は <email> か <url> まで');
    expect(scrubFreeText('電話 090-1234-5678 ID 123456789 token Bearer abc.def', 200)).toBe('電話 <n> ID <n> token <token>');
    expect(scrubFreeText('ＩＤは１２３４５６７', 200)).toBe('IDは<n>');
    expect(scrubFreeText('「ムチ」の音が好き', 200)).toBe('「ムチ」の音が好き');
    expect([...scrubFreeText('あ'.repeat(300), 200)].length).toBe(200);
  });
});

describe('出した・スキップ・答え (REQ-SURVEY-007..010/013)', () => {
  it('shown counts and becomes current; skip is final and idempotent; answer once; nothing granted', async () => {
    const w = world();
    await settled(w, 'p');
    const before = await st(w, 'p');
    const l = live();
    expect(await w.svc.surveyShown('p', l, 'home')).toMatchObject({ surveyId: 'sv_whip_feel', shows: 1 });
    expect((await st(w, 'p')).surveys?.current).toBe('sv_whip_feel');
    const k1 = key();
    const a = await w.svc.surveyAnswer('p', l, { placement: 'home', answers: GOOD, facts }, k1);
    expect(a).toMatchObject({ surveyId: 'sv_whip_feel', outcome: 'answered', at: NOW });
    expect(await w.svc.surveyAnswer('p', l, { placement: 'home', answers: GOOD, facts }, k1)).toEqual(a); // same key → same answer
    expect(await code(w.svc.surveyAnswer('p', l, { placement: 'home', answers: GOOD, facts }, key()))).toBe('CONFLICT');
    expect(await code(w.svc.surveyAnswer('p', l, { placement: 'home', answers: GOOD, facts }, null))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await code(w.svc.surveySkip('p', l, 'home'))).toBe('CONFLICT');
    const after = await st(w, 'p');
    expect(after.wallet).toEqual(before.wallet);
    expect(after.items).toEqual(before.items);
    expect(after.missions).toEqual(before.missions);
    expect(after.titles).toEqual(before.titles);
    expect(after.surveys?.current).toBeNull();
    expect(after.surveys?.done.sv_whip_feel).toMatchObject({ outcome: 'answered', synced: false, answers: GOOD, segment: { platform: 'ios', rankedBand: '10-49', installBand: '7-29d' } });
    const o = await w.svc.surveyOffer('p', [l], facts, 'home', 'ja');
    expect(o.survey).toBeNull();
    expect(o.pending.map((x) => x.surveyId)).toEqual(['sv_whip_feel']);
    await w.svc.surveySynced('p', ['sv_whip_feel']);
    expect((await w.svc.surveyOffer('p', [l], facts, 'home', 'ja')).pending).toEqual([]);
    expect(w.kpi.filter((r) => r.name.startsWith('survey_')).map((r) => [r.name, r.s1, r.s2, r.count])).toEqual([
      ['survey_shown', 'sv_whip_feel', 'home', 1], ['survey_answer', 'sv_whip_feel', 'home', 4]]);
  });
  it('skip: one tap, never offered again, the cool-down starts, KPI once', async () => {
    const w = world();
    await settled(w, 'p');
    const a = live(def({ id: 'sv_aaa' })), b = live(def({ id: 'sv_bbb' }));
    await w.svc.surveyShown('p', a, 'result');
    expect(await w.svc.surveySkip('p', a, 'result')).toMatchObject({ outcome: 'skipped' });
    expect(await w.svc.surveySkip('p', a, 'result')).toMatchObject({ outcome: 'skipped' });
    expect((await w.svc.surveyOffer('p', [a, b], facts, 'home', 'ja')).reason).toBe('cool_down');
    w.clock.now = NOW + 73 * HOUR;
    expect((await w.svc.surveyOffer('p', [a, b], facts, 'home', 'ja')).survey?.id).toBe('sv_bbb');
    expect(await code(w.svc.surveyAnswer('p', a, { placement: 'home', answers: GOOD, facts }, key()))).toBe('CONFLICT');
    expect(w.kpi.filter((r) => r.name === 'survey_skip')).toHaveLength(1);
  });
  it('closed, unknown, scheduled, targeting, deletion and tombstone', async () => {
    const w = world();
    await settled(w, 'p');
    const ans = (l: LiveSurvey | null, id = 'p') => code(w.svc.surveyAnswer(id, l, { placement: 'home', answers: GOOD, facts }, key()));
    expect(await ans(live(SAMPLE, { endAt: NOW - 1 }))).toBe('SURVEY_CLOSED');
    expect(await ans(null)).toBe('NOT_FOUND');
    expect(await ans(live(SAMPLE, { startAt: NOW + 1 }))).toBe('NOT_FOUND');
    expect(await ans(live(def({ targeting: { platforms: ['android'] } })))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.surveyShown('p', live(SAMPLE, { endAt: NOW - 1 }), 'home'))).toBe('SURVEY_CLOSED');
    const off = world({ ...m, progression: { ...m.progression, surveys: { ...CFG, enabled: false } } });
    await settled(off, 'p');
    expect(await code(off.svc.surveyAnswer('p', live(), { placement: 'home', answers: GOOD, facts }, key()))).toBe('SURVEY_CLOSED');
    await w.svc.tx('p', null, (s) => { s.deletion = { status: 'scheduled' } as never; });
    expect(await ans(live())).toBe('NOT_ELIGIBLE');
    w.repo.delete('gone');
    expect(await ans(live(), 'gone')).toBe('NOT_FOUND');
    expect(await code(w.svc.surveyOffer('gone', [live()], facts, 'home', 'ja'))).toBe('NOT_FOUND');
    expect(await code(w.svc.surveySkip('gone', live(), 'home'))).toBe('NOT_FOUND');
  });
  it('analytics off: still answerable, no segment, the optional KPI rows are withheld (REQ-SURVEY-013)', async () => {
    const w = world();
    await settled(w, 'p');
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false });
    w.kpi.length = 0;
    await w.svc.surveyShown('p', live(), 'home');
    await w.svc.surveyAnswer('p', live(), { placement: 'home', answers: GOOD, facts }, key());
    expect((await st(w, 'p')).surveys?.done.sv_whip_feel?.segment).toBeNull();
    expect(w.kpi.filter((r) => r.name.startsWith('survey_'))).toEqual([]);
    for (const n of ['survey_shown', 'survey_skip', 'survey_answer']) expect(kpiClassOf(n)).toBe('optional');
  });
});

describe('運営の保存 (REQ-SURVEY-003/011/014..018)', () => {
  const core = () => { const repo = new MemorySurveyRepo(); return { repo, c: new SurveysCore(repo) }; };
  it('draft → edit (rev) → publish → live → close; edits after publish refused; maxLive', () => {
    const { c } = core();
    expect(c.create(normalizeSurveyDef(SAMPLE), 'op', NOW)).toMatchObject({ status: 'draft', rev: 1 });
    expect(() => c.create(normalizeSurveyDef(SAMPLE), 'op', NOW)).toThrow(/already exists/);
    expect(() => c.update('sv_whip_feel', normalizeSurveyDef(SAMPLE), 7, 'op', NOW)).toThrow(/changed/);
    expect(c.update('sv_whip_feel', normalizeSurveyDef(def({ title: { ja: '手ごたえ', en: 'Feel' } })), 1, 'op', NOW).rev).toBe(2);
    expect(c.live(NOW)).toEqual([]);
    expect(c.one('sv_whip_feel')).toBeNull(); // a draft is invisible to players
    expect(() => c.publish('sv_whip_feel', NOW, NOW + 91 * DAY, 5, 'ad', NOW)).toThrow(/90 days/);
    expect(() => c.publish('sv_whip_feel', NOW - 2 * DAY, NOW - DAY, 5, 'ad', NOW)).toThrow(/future/);
    expect(c.publish('sv_whip_feel', NOW + HOUR, NOW + 3 * DAY, 5, 'ad', NOW).status).toBe('scheduled');
    expect(c.get('sv_whip_feel', NOW + 2 * HOUR).status).toBe('live');
    expect(() => c.update('sv_whip_feel', normalizeSurveyDef(SAMPLE), 2, 'op', NOW)).toThrow(/cannot change/);
    expect(() => c.publish('sv_whip_feel', NOW, NOW + DAY, 5, 'ad', NOW)).toThrow(/already published/);
    c.create(normalizeSurveyDef(def({ id: 'sv_two' })), 'op', NOW);
    expect(() => c.publish('sv_two', NOW, NOW + DAY, 1, 'ad', NOW)).toThrow(/at most 1/);
    const closed = c.close('sv_whip_feel', 'ad', NOW + 2 * HOUR);
    expect(closed.status).toBe('ended');
    expect(c.one('sv_whip_feel')!.endAt).toBe(NOW + 2 * HOUR);
    expect(c.close('sv_whip_feel', 'ad', NOW + 3 * HOUR).closedAt).toBe(NOW + 2 * HOUR);
    expect(c.live(NOW + 3 * HOUR)).toEqual([]);
  });
  it('one row per (survey, player); results; CSV without ids (formula-safe); hide; deletion anonymises and drops texts', () => {
    const { c, repo } = core();
    c.create(normalizeSurveyDef(SAMPLE), 'op', NOW);
    c.publish('sv_whip_feel', NOW, NOW + DAY, 5, 'ad', NOW);
    const seg = { platform: 'ios', classId: 'C', rankedBand: '10-49', installBand: '7-29d' } as const;
    expect(c.ingest([{ surveyId: 'sv_whip_feel', playerId: 'p1', rev: 1, at: NOW, answers: GOOD, segment: seg }])).toEqual({ stored: 1, received: 1 });
    expect(c.ingest([{ surveyId: 'sv_whip_feel', playerId: 'p1', rev: 1, at: NOW, answers: { feel: 1, mode: 'events' }, segment: seg }])).toEqual({ stored: 0, received: 1 });
    c.ingest([{ surveyId: 'sv_whip_feel', playerId: 'p2', rev: 1, at: NOW + 1, answers: { feel: 2, mode: 'events', wish: ['events', 'silks'], free: '=HYPERLINK("x")' }, segment: null }]);
    c.ingest([{ surveyId: 'sv_nope', playerId: 'p2', rev: 1, at: NOW, answers: {}, segment: null }]); // a deleted survey: dropped
    const r = c.results('sv_whip_feel', NOW);
    expect(r).toMatchObject({ total: 2, segmented: 1, unsegmented: 1, platforms: { ios: 1 } });
    const q = Object.fromEntries(r.questions.map((x) => [x.id, x]));
    expect(q.feel).toMatchObject({ answered: 2, scale: { counts: [0, 1, 0, 1, 0], average: 3 } });
    expect((q.mode as { options: unknown[] }).options).toEqual([{ id: 'ranked', text: SAMPLE.questions[1]!.options![0]!.text, count: 1, pct: 50 }, { id: 'events', text: SAMPLE.questions[1]!.options![1]!.text, count: 1, pct: 50 }]);
    expect((q.wish as { options: { count: number }[] }).options.map((o) => o.count)).toEqual([0, 2, 1]);
    const texts = (q.free as { texts: { ref: string; text: string; hidden: boolean }[] }).texts;
    expect(JSON.stringify(r)).not.toMatch(/p1|p2/); // no player ids anywhere in the results
    const csv = c.csv('sv_whip_feel', NOW);
    expect(csv.rows).toBe(2);
    expect(csv.csv).not.toMatch(/p1|p2/);
    expect(csv.csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-1')).toBe(`"'-1"`);
    const ref = texts.find((t) => t.text.startsWith('='))!.ref;
    c.hideText('sv_whip_feel', ref, true);
    expect(c.csv('sv_whip_feel', NOW).csv).toContain('(hidden)');
    expect(() => c.hideText('sv_whip_feel', '999.free', true)).toThrow(/unknown text/);
    expect(() => c.hideText('sv_whip_feel', `${ref.split('.')[0]}.feel`, true)).toThrow(/unknown text/);
    expect(c.forgetPlayer('p2')).toEqual({ anonymised: 1 });
    const rows = repo.answers('sv_whip_feel');
    expect(rows.map((x) => x.owner).sort()).toEqual(['anon:2', 'p1']);
    expect(rows.find((x) => x.owner === 'anon:2')!.answers).toEqual({ feel: 2, mode: 'events', wish: ['events', 'silks'] });
    expect(c.results('sv_whip_feel', NOW).total).toBe(2); // the choices stay in the counts
  });
});

describe('仕組みのつながり (REQ-SURVEY-014/019/020)', () => {
  it('state key classified, export rows, deletion step order, maintenance group', async () => {
    expect(classifyKey('surveys')).toEqual({ section: 'analytics' });
    expect(DELETION_STEPS.indexOf('surveys')).toBe(DELETION_STEPS.indexOf('client_errors') + 1);
    expect(DELETION_STEPS.indexOf('data_export')).toBe(DELETION_STEPS.indexOf('surveys') + 1);
    for (const p of ['/v1/surveys/current', '/v1/surveys/sv_x/answers', '/v1/surveys/sv_x/skip']) expect(endpointGroup(p)).toBe('core');
    const w = world();
    await settled(w, 'p');
    await w.svc.surveyAnswer('p', live(), { placement: 'result', answers: GOOD, facts }, key());
    const doc = buildExportDocument(m, await st(w, 'p'), { ledger: [], gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_x', 'ja', NOW);
    expect(doc.analytics.surveys).toEqual([{ surveyId: 'sv_whip_feel', title: 'ムチの手ごたえ', titleEn: 'How the whip feels', outcome: 'answered', at: NOW, placement: 'result', answers: GOOD }]);
  });
  it('the deletion run calls the surveys port', async () => {
    const calls: string[] = [];
    const ports = {
      snapshot: async () => ({ steps: [], friends: [], incoming: [], outgoing: [], teamRequests: [], teamId: null, ghostKeys: [], eventIds: [] }),
      markStep: async () => {}, friends: {}, directory: { forget: async () => {} }, leaderboards: { forget: async () => {}, deleteGhosts: async () => {} },
      surveys: { forget: async (u: string) => { calls.push(`surveys:${u}`); } },
      finalize: async () => ({ rev: 1 }), retain: async () => {}, wipe: async () => { calls.push('wipe'); },
    } as unknown as DeletionPorts;
    await runAccountDeletion(ports, 'p9', NOW);
    expect(calls).toEqual(['surveys:p9', 'wipe']);
  });
});

const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789', admin: 'admin-token-0123456789' };
async function app(master: Master = m) {
  let now = NOW;
  const w = world(master);
  w.clock.now = now;
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((['viewer', 'operator', 'admin'] as const).map(async (r) => ({ name: r, role: r, sha256: await sha256Hex(TOKENS[r]) }))) };
  const c = {
    master, baseMaster: master,
    authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => now,
    paidBalance: async () => ({}), adminToken: undefined, parseStoreNotification: async () => null,
    ops: ops.api, authenticateAdmin: (req: Request) => authenticateAdmin(req, auth),
  } as unknown as AppContext;
  const call = async (method: string, path: string, o: { body?: unknown; user?: string; idem?: string; role?: keyof typeof TOKENS; lang?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.idem ? { 'idempotency-key': o.idem } : {}), ...(o.lang ? { 'accept-language': o.lang } : {}), ...(o.headers ?? {}) };
    if (o.role) headers.authorization = `Bearer ${TOKENS[o.role]}`; else headers['x-test-user'] = o.user ?? 'p';
    const res = await handle(new Request(`https://x${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { w, ops, c, call, setNow: (t: number) => { now = t; w.clock.now = t; } };
}

describe('HTTP: プレイヤーと運営の画面 (REQ-SURVEY-005..011/015..018)', () => {
  it('the console flow: validate (preview) → draft → edit → publish (admin) → players answer → results / CSV / hide', async () => {
    const { w, call, ops, setNow } = await app();
    await settled(w, 'p');
    await settled(w, 'q');
    const hdr = { 'x-client-platform': 'ios', 'x-client-version': '1.4.0' };
    // roles: a viewer cannot create; validate shows problems and both languages
    expect((await call('POST', '/v1/admin/surveys', { role: 'viewer', body: { survey: SAMPLE, reason: 'new survey' } })).status).toBe(403);
    const v = await call('POST', '/v1/admin/surveys/validate', { role: 'viewer', body: { survey: { ...SAMPLE, title: { ja: '配当', en: 'x' } } } });
    expect(v.body.problems.join()).toMatch(/betting/);
    const ok = await call('POST', '/v1/admin/surveys/validate', { role: 'viewer', body: { survey: SAMPLE } });
    expect(ok.body).toMatchObject({ problems: [], preview: { ja: { title: 'ムチの手ごたえ' }, en: { title: 'How the whip feels' } } });
    const bad = await call('POST', '/v1/admin/surveys', { role: 'operator', body: { survey: { ...SAMPLE, reward: 1 }, reason: 'new survey' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.problems.join()).toMatch(/never rewarded/);
    expect((await call('POST', '/v1/admin/surveys', { role: 'operator', body: { survey: SAMPLE, reason: 'new survey' } })).body).toMatchObject({ status: 'draft', rev: 1 });
    expect((await call('PUT', '/v1/admin/surveys/sv_whip_feel', { role: 'operator', body: { survey: SAMPLE, rev: 1, reason: 'typo' } })).body.rev).toBe(2);
    // a draft is invisible to players
    expect((await call('GET', '/v1/surveys/current?placement=home', { headers: hdr })).body).toEqual({ survey: null, reason: 'none' });
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'home', answers: GOOD }, idem: 'c:a1', headers: hdr })).status).toBe(404);
    expect((await call('POST', '/v1/admin/surveys/sv_whip_feel/publish', { role: 'operator', body: { startAt: NOW, endAt: NOW + DAY, reason: 'go live' } })).status).toBe(403);
    expect((await call('POST', '/v1/admin/surveys/sv_whip_feel/publish', { role: 'admin', body: { startAt: NOW, endAt: NOW + DAY, reason: 'go live' } })).body.status).toBe('live');
    // player: offer in English, shown, answer (strict), answer again
    const cur = await call('GET', '/v1/surveys/current?placement=result', { headers: hdr, lang: 'en' });
    expect(cur.body).toMatchObject({ reason: null, survey: { id: 'sv_whip_feel', title: 'How the whip feels', placement: 'result' } });
    expect(cur.body.pending).toBeUndefined();
    expect((await call('GET', '/v1/surveys/current?placement=race')).status).toBe(400);
    expect((await call('POST', '/v1/surveys/sv_whip_feel/shown', { body: { placement: 'result' } })).body.shows).toBe(1);
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: GOOD }, headers: hdr })).status).toBe(400); // no key
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: { ...GOOD, x: 1 } }, idem: 'c:a2', headers: hdr })).status).toBe(400);
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: GOOD, coins: 5 }, idem: 'c:a2', headers: hdr })).status).toBe(400);
    const a = await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: { ...GOOD, free: 'mail me at a@b.co' } }, idem: 'c:a3', headers: hdr });
    expect(a.body).toEqual({ surveyId: 'sv_whip_feel', outcome: 'answered', at: NOW });
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: GOOD }, idem: 'c:a3', headers: hdr })).body).toEqual(a.body);
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'result', answers: GOOD }, idem: 'c:a4', headers: hdr })).status).toBe(409);
    expect((await st(w, 'p')).surveys?.done.sv_whip_feel?.synced).toBe(true);
    // q skips
    expect((await call('POST', '/v1/surveys/sv_whip_feel/skip', { user: 'q', body: { placement: 'home' } })).body.outcome).toBe('skipped');
    expect((await call('GET', '/v1/surveys/current?placement=home', { user: 'q', headers: hdr })).body.reason).toBe('cool_down');
    // results (no ids), CSV, hide
    const res = await call('GET', '/v1/admin/surveys/sv_whip_feel/results', { role: 'viewer' });
    expect(res.body).toMatchObject({ total: 1, segmented: 1 });
    const free = res.body.questions.find((x: { id: string }) => x.id === 'free');
    expect(free.texts[0].text).toBe('mail me at <email>');
    expect(JSON.stringify(res.body)).not.toContain('"p"');
    expect((await call('POST', `/v1/admin/surveys/sv_whip_feel/texts/${free.texts[0].ref}/hide`, { role: 'operator', body: { hidden: true, reason: 'personal info' } })).body).toEqual({ ref: free.texts[0].ref, hidden: true });
    const csv = await call('GET', '/v1/admin/surveys/sv_whip_feel/results.csv', { role: 'viewer' });
    expect(csv.body.csv).toContain('(hidden)');
    expect((await call('GET', '/v1/admin/surveys', { role: 'viewer' })).body[0]).toMatchObject({ id: 'sv_whip_feel', status: 'live', answers: 1 });
    // audit trail of the writes
    const audit = (await ops.api.auditQuery({ limit: 50 })).map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['surveys.create', 'surveys.update', 'surveys.publish', 'surveys.text.hide']));
    // close (admin) → players get the neutral SURVEY_CLOSED
    expect((await call('POST', '/v1/admin/surveys/sv_whip_feel/close', { role: 'admin', body: { reason: 'enough answers' } })).body.status).toBe('ended');
    setNow(NOW + HOUR);
    const r3 = await settled(w, 'r');
    void r3;
    const closed = await call('POST', '/v1/surveys/sv_whip_feel/answers', { user: 'r', body: { placement: 'home', answers: GOOD }, idem: 'c:a5', headers: hdr });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('SURVEY_CLOSED');
    expect((await call('GET', '/v1/surveys/current?placement=home', { user: 'r', headers: hdr })).body.survey).toBeNull();
  });
  it('an answer the ops table missed is re-sent on the next offer read', async () => {
    const { w, call, ops } = await app();
    await settled(w, 'p');
    await ops.api.surveys!.create(normalizeSurveyDef(SAMPLE), 'op', NOW);
    await ops.api.surveys!.publish('sv_whip_feel', NOW, NOW + DAY, 5, 'ad', NOW);
    const ingest = ops.api.surveys!.ingest;
    ops.api.surveys!.ingest = async () => { throw new Error('ops down'); };
    expect((await call('POST', '/v1/surveys/sv_whip_feel/answers', { body: { placement: 'home', answers: GOOD }, idem: 'c:z1' })).status).toBe(200); // saved on the player
    expect((await st(w, 'p')).surveys?.done.sv_whip_feel?.synced).toBe(false);
    ops.api.surveys!.ingest = ingest;
    await call('GET', '/v1/surveys/current?placement=home');
    expect((await st(w, 'p')).surveys?.done.sv_whip_feel?.synced).toBe(true);
    expect(ops.surveys.results('sv_whip_feel', NOW).total).toBe(1);
  });
});
