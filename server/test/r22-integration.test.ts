// Round 22 integration: §66 騎手の道, §67 使いすぎ・遊びすぎの防止, §68 昇級戦と降級の猶予, §69 ゲーム内アンケート against each
// other and against Rounds 17–21 (§46 maintenance, §48 help, §51 data export, §54 transfer / AccountChangeReset, §57 tips,
// §58 KPI consent and the one-prompt rule, §60 error reports, §61 local notifications, §63 deep links, §65 calendar, deletion).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES, endpointGroup, gateRequest, jstToMs, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { routes } from '../src/http/app.js';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import type { ReplayLog, VerifierOutput } from '../src/domain/schemas.js';
import type { VerifierClient } from '../src/domain/verifier.js';
import type { PlayerInvoker } from '../src/http/app.js';
import { CareerService } from '../src/race/career.js';
import { careerOf } from '../src/domain/career.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { scrubFreeText } from '../src/domain/surveys.js';
import { CALENDAR_KINDS } from '../src/domain/calendar.js';
import { LINK_TYPES } from '../src/domain/deepLinks.js';
import { DEX_CLASSIFICATION } from '../src/domain/dataExport.js';
import { DELETION_STEPS } from '../src/domain/accountDeletion.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');
const section = (doc: string, from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to, doc.indexOf(from) + 1));

describe('§58.11 × Round 22: the outcome sheet goes through the ONE prompt mechanism; the play-time sheet is the documented exception; surveys never interrupt', () => {
  it('the table has promotion_outcome after release_notes, no survey row, and a numberless exempt row for the play-time reminder', () => {
    const p = read('contracts/protocol.md');
    const s = section(p, '### 58.11', '## 59.');
    const ids = [...s.matchAll(/^\s*\| \d \| `([a-z_]+)` \|/gm)].map((x) => x[1]);
    expect(ids.indexOf('promotion_outcome')).toBe(ids.indexOf('release_notes') + 1);
    expect(ids.indexOf('promotion_outcome')).toBeLessThan(ids.indexOf('reminders_pre_permission'));
    expect(ids).not.toContain('survey');
    expect(ids.at(-1)).toBe('review_prompt');
    const exempt = s.split('\n').find((l) => /^\s*\| — \| `playtime_reminder` \|/.test(l));
    expect(exempt, 'exempt row').toBeTruthy();
    expect(exempt).toContain('§67');
    expect(exempt).toContain('表の外');
    // §67, §68 and §69 point at the one mechanism, never at the Round 20 gate
    for (const [a, b] of [['## 66.', '## 67.'], ['## 67.', '## 68.'], ['## 68.', '## 69.'], ['## 69.', '\n## 70.']] as const) {
      const sec = p.includes(b) ? section(p, a, b) : p.slice(p.indexOf(a));
      expect(sec, a).not.toMatch(/SessionPromptGate|SessionPromptKind/);
    }
    expect(section(p, '## 68.', '## 69.')).toContain('promotion_outcome');
    // §69 (the user's change in R22 integration): a quiet row inside お知らせ, never a home card, never a sheet after a result
    const s69 = p.slice(p.indexOf('## 69.'));
    expect(s69).toContain('`inbox`');
    expect(s69).toContain('お知らせ');
    expect(s69).toMatch(/§58\.11 の表に入らない/);
  });
  it('Unity models, checks and the engine use Muchi.Client.SessionPrompts only (the Round 20 gate types are gone)', () => {
    const all = [csFiles('unity/Assets/Muchi/Game'), csFiles('unity/Checks~/GameChecks'), csFiles('engine/Muchi.Client')].join('\n');
    expect(all).not.toMatch(/class SessionPromptGate|new SessionPromptGate|SessionPromptGate \w+ \{|SessionPromptKind|\.Claim\(SessionPrompt/);
    const game = csFiles('unity/Assets/Muchi/Game');
    expect(game).toMatch(/TryClaim\(SessionPrompts\.PromotionOutcome\b/);
    expect(game).not.toMatch(/SessionPrompts\.Survey\b/);
    expect(read('engine/Muchi.Client/ReleaseNotes.cs')).not.toMatch(/Survey = "survey"/);
    const sv = read('unity/Assets/Muchi/Game/SurveyModel.cs');
    expect(sv).not.toMatch(/SessionPrompts|Prompts \{ get; set; \}/);
    expect(sv).not.toMatch(/CardVisible|"home"|"result"/);
    // the play-time sheet never claims (player-requested); it is shown before the prompts at the same safe point
    const slFile = read('unity/Assets/Muchi/Game/SelfLimitsModel.cs');
    const sl = slFile.slice(slFile.indexOf('class SelfLimitsModel'));
    expect(sl).not.toMatch(/Prompts|TryClaim/);
  });
  it('the prototype claims promotion_outcome through sessionPrompt; surveys and the play-time sheet do not', () => {
    const app = read('tools/figma-prototype/site/app.js');
    expect(app).toMatch(/sessionPrompt\.claim\('promotion_outcome'\)/);
    expect(app).not.toMatch(/sessionPrompt\.(claim|can)\('promotion'\)/);
    expect(app).not.toMatch(/sessionPrompt\.(claim|can)\('survey'\)|shown === 'survey'/);
    expect(app).not.toMatch(/SurveyHomeCard|svOffer\('home'\)|svOffer\('result'\)/);
    // the quiet entry: a row on the お知らせ screen (with at most a small dot there), nothing on the home screen
    const act = app.indexOf('async function Activity(');
    expect(app.slice(act, app.indexOf('\n}\n', act))).toContain("dataset.action = 'survey'");
    const home = app.indexOf('async function Home(');
    expect(app.slice(home, app.indexOf('\n}\n', home))).not.toMatch(/[Ss]urvey|sv[A-Z]/);
    const i = app.indexOf('function PlaytimeSheet(');
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, app.indexOf('\n}\n', i))).not.toMatch(/sessionPrompt/);
  });
});

/** Every KPI event Round 22 added (server rows and client events). */
const R22_KPI = {
  career: ['career_start', 'career_clear', 'career_star'],
  selfLimits: ['self_limit_set', 'self_limit_block', 'playtime_setting_change', 'playtime_reminder_shown'],
  promotion: ['promo_series_start', 'promo_series_end', 'demotion_shield_used'],
  surveys: ['survey_shown', 'survey_skip', 'survey_answer'],
};
const ALL_R22_KPI = Object.values(R22_KPI).flat();

describe('§58 KPI classification of the Round 22 events (REQ-CNS-012, §58.7)', () => {
  it('self_limit_set is essential (the record of the player\'s own spending limit); every other Round 22 event is optional', () => {
    for (const n of ALL_R22_KPI) {
      const want = n === 'self_limit_set' ? 'essential' : 'optional';
      expect(KPI_EVENT_CLASS[n], n).toBe(want);
      expect(kpiClassOf(n), n).toBe(want);
      expect(n in KPI_ESSENTIAL, n).toBe(want === 'essential');
    }
  });
  it('§58.7 in the protocol lists every Round 22 event with its class', () => {
    const p = read('contracts/protocol.md');
    const s = section(p, '### 58.7', '### 58.8');
    const row = s.split('\n').find((l) => l.includes('Round 22') || l.includes('§66'));
    expect(row, 'a Round 22 row').toBeTruthy();
    for (const n of ALL_R22_KPI) expect(s, n).toContain(n);
  });
  it('the one client event (playtime_reminder_shown) is accepted by the collector, built by Muchi.Client, and every event is in kpi-queries.md', () => {
    const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
    expect(names).toContain('playtime_reminder_shown');
    for (const n of ALL_R22_KPI.filter((x) => x !== 'playtime_reminder_shown')) expect(names, `${n} is a server row`).not.toContain(n);
    expect(csFiles('engine/Muchi.Client')).toContain('"playtime_reminder_shown"');
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ALL_R22_KPI) expect(q, n).toContain(n);
  });
});

// ---- a player service world shared by the cross-feature checks below
const NOV = Date.UTC(2026, 10, 10, 3); // Tuesday 2026-11-10 12:00 JST
function world(now = NOV) {
  const clock = { now };
  const kpi: KpiRecord[] = [];
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(7), clock: () => clock.now, verifiers: {}, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  return { svc, repo, kpi, invoker, clock };
}
type W = ReturnType<typeof world>;
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;
let seq = 0;
const ranked = (place: number): RaceResultForPlayer => ({ raceId: `r22_${++seq}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, startAtMs: NOV + seq * 1000 });
/** Fake verifier: the player's slot finishes first. */
class WinVerifier implements VerifierClient {
  async verify(log: ReplayLog): Promise<VerifierOutput> {
    const me = log.config.entrants.findIndex((e) => e.kind === 'human');
    const order = [me, ...log.config.entrants.map((e) => e.slot).filter((x) => x !== me)];
    const finishTicks = order.map((_, i) => 1800 + i * 10);
    return { resultHash: 'a'.repeat(64), order, finishTicks, finishFracs: finishTicks.map(() => 0), checksums: {} };
  }
}
async function careerWin(w: W, uid: string, raceId: string) {
  await w.svc.bootstrap(uid);
  const s = w.repo.get(uid)!;
  const h = createHorseFromTemplate(s, m.templateById.get('t_partner')!, w.clock.now);
  w.repo.put(s);
  const cs = new CareerService({ player: () => w.invoker, verifier: new WinVerifier(), ticketSecret: 'test-secret', clock: () => w.clock.now });
  const start = await cs.start(uid, raceId, h.id, `k:${raceId}:${++seq}`, 'ja');
  return cs.submit(uid, { sessionId: start.sessionId, token: start.token, inputs: [], resultHash: 'a'.repeat(64) });
}

describe('§66 騎手の道 × §68 昇級戦: a career race never counts toward season points or a series', () => {
  const R1 = careerOf(m).chapters[0]!.races[0]!;
  it('just below the line: a career win adds no points and starts no series', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.tx('p', null, (s) => { s.season.points = 290; s.flags.tutorialGachaUsed = true; });
    const r = await careerWin(w, 'p', R1.id);
    expect(r.cleared).toBe(true);
    const s = await st(w, 'p');
    expect(s.season.points).toBe(290);
    expect((await w.svc.promotion('p')).series).toBeNull();
    expect(w.kpi.filter((k) => /^promo_|^demotion_/.test(k.name))).toEqual([]);
  });
  it('inside a running series: a career win is not a series race (pips, next and points unchanged)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.tx('p', null, (s) => { s.season.points = 290; s.flags.tutorialGachaUsed = true; });
    await w.svc.applyRace('p', ranked(1)); // reaches the line → the series starts
    const before = await w.svc.promotion('p');
    expect(before.series).toMatchObject({ status: 'active', next: 1 });
    const pts = (await st(w, 'p')).season.points;
    await careerWin(w, 'p', R1.id);
    const after = await w.svc.promotion('p');
    expect(after.series).toEqual(before.series);
    expect((await st(w, 'p')).season.points).toBe(pts);
    expect(w.kpi.filter((k) => k.name === 'promo_series_end')).toEqual([]);
  });
});

describe('§67 自分の上限 × §66 / §68 / §69: the own limit only ever refuses a purchase (nothing is sold in the others)', () => {
  const R1 = careerOf(m).chapters[0]!.races[0]!;
  it('SELF_LIMIT_EXCEEDED comes from productBlock only; career, promotion and surveys never read the own limit', () => {
    const files = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);
    const producers = files('server/src').filter((f) => /code: 'SELF_LIMIT_EXCEEDED'|new AppError\('SELF_LIMIT_EXCEEDED'/.test(read(f)));
    expect(producers).toEqual(['server/src/domain/purchase.ts']);
    for (const f of ['server/src/domain/career.ts', 'server/src/race/career.ts', 'server/src/domain/promotion.ts', 'server/src/domain/surveys.ts', 'server/src/ops/surveys.ts']) {
      expect(read(f), f).not.toMatch(/selfLimit|SELF_LIMIT/);
    }
  });
  it('a player at their own monthly limit still runs and clears a career race (and its free rewards are paid)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setSpendingLimit('p', 1000);
    await w.svc.tx('p', null, (s) => { s.monthlySpendYen['2026-11'] = 1000; s.flags.tutorialGachaUsed = true; });
    expect((await w.svc.selfLimits('p')).spending).toMatchObject({ limitYen: 1000 });
    const r = await careerWin(w, 'p', R1.id);
    expect(r.cleared).toBe(true);
  });
});

describe('§69 アンケート × §60 scrubber: free text loses every secret the shared §60 vectors scrub', () => {
  const placeholders = (x: string) => (x.match(/<(email|token|url|id|n)>/g) ?? []).sort();
  it('for every message vector, the free-text scrub leaves the same placeholders (Japanese text and quotes stay: they are the answer)', () => {
    const vec = JSON.parse(read('contracts/client-errors.vectors.json')) as { messages: { input: string; output: string }[] };
    let checked = 0;
    for (const v of vec.messages) {
      if (placeholders(v.output).length === 0) continue;
      expect(placeholders(scrubFreeText(v.input, 1000)), v.input).toEqual(placeholders(v.output));
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
  it('a pasted §63 share link or bare link token never reaches the ops table', () => {
    expect(scrubFreeText('部屋は /l/kmqxphrabcdefghjkmnpqr です', 200)).toBe('部屋は /l/<token> です');
    expect(scrubFreeText('招待 kmqxphrabcdefghjkmnpqr どうぞ', 200)).toBe('招待 <token> どうぞ');
    expect(scrubFreeText('muchi://l/kmqxphrabcdefghjkmnpqr', 200)).toBe('<url>');
  });
});

describe('§54 AccountChangeReset × Round 22: the per-account device state of all four features goes', () => {
  it('Unity: the reset holds SelfLimits, Promotion, Career and Surveys and calls their account methods; GameChecks covers it', () => {
    const f = read('unity/Assets/Muchi/Game/SessionPromptGate.cs');
    const cls = f.slice(f.indexOf('public sealed class AccountChangeReset'));
    for (const [prop, call] of [['SelfLimitsModel SelfLimits', 'SelfLimits?.ForgetAccount()'], ['PromotionModel Promotion', 'Promotion?.ForgetAccount()'], ['CareerModel Career', 'Career?.ForgetAccount()'], ['SurveyModel Surveys', 'Surveys?.ResetSession()']]) {
      expect(cls, prop).toContain(`public ${prop} { get; set; }`);
      expect(cls, call).toContain(call);
    }
    const checks = read('unity/Checks~/GameChecks/Round22IntegrationChecks.cs');
    expect(checks).toMatch(/new AccountChangeReset \{ SelfLimits = limits, Promotion = promo, Career = career/);
    expect(read('unity/Checks~/GameChecks/Program.cs')).toContain('Round22IntegrationChecks.Run(');
  });
  it('prototype: deviceAccountChanged drops the play-time clock, a waiting outcome sheet and the survey sheet', () => {
    const app = read('tools/figma-prototype/site/app.js');
    const i = app.indexOf('function deviceAccountChanged(');
    const body = app.slice(i, app.indexOf('\n}\n', i));
    for (const s of ['svSession = null', 'promoDeferred = null', 'PT_KEY']) expect(body, s).toContain(s);
  });
});

describe('§46 gates × Round 22 routes (§46.2)', () => {
  const START = jstToMs('2026-11-12T02:00')!;
  const win = (scope: MaintenanceConfig['windows'][number]['scope']): MaintenanceConfig => ({
    ...structuredClone(DEFAULT_MAINTENANCE),
    windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * 3600_000, scope, message: { ja: '点検中', en: 'Checks' } }],
    clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.apple.com/jp/app/id1234567890' }, android: DEFAULT_MAINTENANCE.clientVersions.android },
  });
  const none = { platform: null, version: null, engine: null };
  const old = { platform: 'ios', version: '1.0.0', engine: null };
  const GROUPS: Record<string, string> = {
    'GET /v1/career': 'time_attack', 'POST /v1/career/races/:raceId/start': 'time_attack',
    'GET /v1/promotion': 'core', 'POST /v1/promotion/ack': 'core',
    'GET /v1/surveys/current': 'core', 'POST /v1/surveys/:surveyId/shown': 'core', 'POST /v1/surveys/:surveyId/skip': 'core', 'POST /v1/surveys/:surveyId/answers': 'core',
  };
  /** §66 submit (a verified run is never lost) and §67 (lowering a limit must work whenever a purchase can). */
  const EXEMPT = ['POST /v1/career/submit', 'GET /v1/self-limits', 'PUT /v1/self-limits/spending', 'DELETE /v1/self-limits/spending/pending', 'PUT /v1/self-limits/playtime'];
  const fill = (path: string) => path.replace(':raceId', 'car_c1_r1').replace(':surveyId', 'sv_whip_feel');
  it('every Round 22 route exists and sits in its group or is exempt on purpose; none is left unplaced', () => {
    const have = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [r, g] of Object.entries(GROUPS)) {
      expect(have.has(r), r).toBe(true);
      expect(endpointGroup(r.split(' ')[1]!), r).toBe(g);
      expect((EXEMPT_ROUTES as readonly string[]).includes(r), r).toBe(false);
    }
    for (const r of EXEMPT) { expect(have.has(r), r).toBe(true); expect(EXEMPT_ROUTES, r).toContain(r); }
    const r22 = [...have].filter((r) => /^[A-Z]+ \/v1\/(career|self-limits|promotion|surveys)/.test(r));
    expect(r22.filter((r) => !(r in GROUPS) && !EXEMPT.includes(r))).toEqual([]);
  });
  it('a window on the group closes it (core under `all`); the exempt routes answer in any window and from an outdated app', () => {
    for (const [r, g] of Object.entries(GROUPS)) {
      const [method, path] = r.split(' ');
      expect(gateRequest(win(g === 'core' ? 'all' : [g as never]), method!, fill(path!), none, START)?.code, r).toBe('MAINTENANCE');
      if (g !== 'core') expect(gateRequest(win(['gacha']), method!, fill(path!), none, START), r).toBeNull();
    }
    for (const r of EXEMPT) {
      const [method, path] = r.split(' ');
      expect(gateRequest(win('all'), method!, path!, none, START), r).toBeNull();
      expect(gateRequest(win('all'), method!, path!, old, START), r).toBeNull();
    }
    // a shop window never closes the own-limit settings (they are not under /v1/shop)
    expect(gateRequest(win(['shop' as never]), 'PUT', '/v1/self-limits/spending', none, START)).toBeNull();
  });
  it('§46.2 names every Round 22 route family', () => {
    const p = read('contracts/protocol.md');
    const s46 = section(p, '### 46.2', '### 46.3');
    for (const r of ['/v1/career', '/v1/career/submit', '/v1/self-limits', '/v1/promotion', '/v1/surveys']) expect(s46, r).toContain(r);
  });
});

describe('その他 stays at eight rows per page; Round 22 entries live on their hubs (06 「その他 のページ」)', () => {
  const app = read('tools/figma-prototype/site/app.js');
  const body = (fn: string) => { const i = app.search(new RegExp(`(async )?function ${fn}\\(`)); return app.slice(i, app.indexOf('\n}\n', i)); };
  it('no Round 22 row on either その他 page; career in the race lobby, self-limits under the purchase history, surveys in お知らせ', () => {
    const block = app.slice(app.indexOf('const morePages = {'), app.indexOf("Kicker('その他', 36, 30, m);"));
    for (const r of ['騎手の道', '上限', 'アンケート', '昇級戦']) expect(block, r).not.toContain(r);
    expect(body('RaceLobby')).toMatch(/Ghost\('騎手の道'[^\n]*Career\(\)/);
    expect(body('History')).toMatch(/TextLink\('上限の設定'[^\n]*SelfLimits\(/);
    expect(body('Activity')).toContain("dataset.action = 'survey'");
    const ux = read('docs/planning/06-ux-experience-spec.md');
    const tbl = ux.slice(ux.indexOf('### その他 のページ'));
    expect(tbl).toContain('Round 22 の入口');
    for (const w of ['騎手の道（§66）', '使いすぎ・遊びすぎの防止（§67）', '昇級戦（§68）', 'ゲーム内アンケート（§69）']) expect(tbl, w).toContain(w);
  });
});

describe('§48 help / §57 tips × Round 22', () => {
  const help = JSON.parse(read('server/master/help.json')) as { articles: { id: string; body: { ja: string; en: string } }[] };
  const tips = JSON.parse(read('server/master/tips.json')) as { tips: { id: string; topic: string; help: string; unlock: string | null }[] };
  it('every Round 22 feature has a help article; career, limits and promotion a tip in a fitting topic; surveys none (kept quiet)', () => {
    for (const id of ['career_mode', 'self_limits', 'promotion_series', 'surveys']) expect(help.articles.map((a) => a.id), id).toContain(id);
    const tip = (h: string) => tips.tips.filter((t) => t.help === h);
    expect(tip('career_mode').map((t) => t.topic)).toEqual(['race']);
    expect(tip('promotion_series').map((t) => t.topic)).toEqual(['race']);
    expect(tip('self_limits').map((t) => t.topic)).toEqual(['shop']);
    // R22 integration (the user's change to §69): no tip card advertises surveys; the article says where the quiet row is
    expect(tip('surveys')).toEqual([]);
    const sv = help.articles.find((a) => a.id === 'surveys')!;
    expect(sv.body.ja).toContain('お知らせ');
    expect(sv.body.ja).not.toMatch(/ホームのカード|結果を閉じた後に出ます/);
    expect(sv.body.en).toContain('News screen');
  });
});

describe('deploy §7.1: one Round 22 row (no migration, v9 still reserved; the before-production items for the own limits)', () => {
  it('the row exists once after Round 21 and covers the four features, order, rollback, kill switches and the legal items', () => {
    const d = read('docs/ops/deploy.md');
    const rows = d.split('\n').filter((l) => l.startsWith('| Round 22'));
    expect(rows).toHaveLength(1);
    expect(d.indexOf('| Round 21')).toBeLessThan(d.indexOf('| Round 22'));
    for (const s of ['§66', '§67', '§68', '§69', 'マイグレーションは無い', '`v9`', '切り戻し', '冷却期間', '利用規約', 'survey_answers', 'progression.promotion.enabled', 'progression.surveys.enabled', 'config.enabled', '`selfLimits`', 'placement=inbox', '検証サーバーは出し直さなくてよい']) expect(rows[0], s).toContain(s);
    const wr = read('server/wrangler.toml');
    expect(wr).not.toMatch(/tag = "v9"/);
    expect(wr.match(/tag = "v\d+"/g)!.at(-1)).toBe('tag = "v7"');
  });
});

describe('Round 22 × §65 calendar / §63 links / §51 export / deletion / §62 showcase: the decisions hold', () => {
  it('career has no time window → no calendar kind; no career link target (not trivial: server tokens, parser, prototype)', () => {
    expect((CALENDAR_KINDS as readonly string[]).filter((k) => /career|promo|survey|limit/.test(k))).toEqual([]);
    expect((LINK_TYPES as readonly string[]).includes('career')).toBe(false);
  });
  it('§51: career play, selfLimits settings, promotion play, surveys analytics; the deletion runs the surveys step before finalize', () => {
    expect(DEX_CLASSIFICATION).toMatchObject({ career: { section: 'play' }, selfLimits: { section: 'settings' }, promotion: { section: 'play' }, surveys: { section: 'analytics' } });
    expect(DELETION_STEPS.indexOf('surveys')).toBeGreaterThan(-1);
    expect(DELETION_STEPS.indexOf('surveys')).toBeLessThan(DELETION_STEPS.indexOf('finalize'));
  });
  it('§62 showcase and §68 promotion do not read each other (pins and records are unaffected by a series)', () => {
    expect(read('server/src/domain/showcase.ts')).not.toMatch(/promotion/);
    expect(read('server/src/domain/promotion.ts')).not.toMatch(/showcase/);
  });
  it('protocol §69.12 lists what the Round 22 integration decided', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 69.12'));
    for (const w of ['promotion_outcome', 'playtime_reminder', 'お知らせ', '§65', '§63', 'SELF_LIMIT_EXCEEDED', 'シーズンポイント', 'AccountChangeReset', '§60']) expect(s, w).toContain(w);
  });
});
