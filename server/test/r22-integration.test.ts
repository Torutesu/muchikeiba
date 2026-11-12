// Round 22 integration: §66 騎手の道, §67 使いすぎ・遊びすぎの防止, §68 昇級戦と降級の猶予, §69 ゲーム内アンケート against each
// other and against Rounds 17–21 (§46 maintenance, §48 help, §51 data export, §54 transfer / AccountChangeReset, §57 tips,
// §58 KPI consent and the one-prompt rule, §60 error reports, §61 local notifications, §63 deep links, §65 calendar, deletion).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';
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

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');
const section = (doc: string, from: string, to: string) => doc.slice(doc.indexOf(from), doc.indexOf(to, doc.indexOf(from) + 1));

describe('§58.11 × Round 22: the outcome sheet and the survey go through the ONE prompt mechanism; the play-time sheet is the documented exception', () => {
  it('the table has promotion_outcome after release_notes and survey last, and a numberless exempt row for the play-time reminder', () => {
    const p = read('contracts/protocol.md');
    const s = section(p, '### 58.11', '## 59.');
    const ids = [...s.matchAll(/^\s*\| \d \| `([a-z_]+)` \|/gm)].map((x) => x[1]);
    expect(ids.indexOf('promotion_outcome')).toBe(ids.indexOf('release_notes') + 1);
    expect(ids.indexOf('promotion_outcome')).toBeLessThan(ids.indexOf('reminders_pre_permission'));
    expect(ids.at(-1)).toBe('survey');
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
    expect(p.slice(p.indexOf('## 69.'))).toContain('`survey`');
  });
  it('Unity models, checks and the engine use Muchi.Client.SessionPrompts only (the Round 20 gate types are gone)', () => {
    const all = [csFiles('unity/Assets/Muchi/Game'), csFiles('unity/Checks~/GameChecks'), csFiles('engine/Muchi.Client')].join('\n');
    expect(all).not.toMatch(/class SessionPromptGate|new SessionPromptGate|SessionPromptGate \w+ \{|SessionPromptKind|\.Claim\(SessionPrompt/);
    const game = csFiles('unity/Assets/Muchi/Game');
    expect(game).toMatch(/TryClaim\(SessionPrompts\.PromotionOutcome\b/);
    expect(game).toMatch(/CanShow\(SessionPrompts\.Survey\b/);
    expect(game).toMatch(/TryClaim\(SessionPrompts\.Survey\b/);
    // the play-time sheet never claims (player-requested); it is shown before the prompts at the same safe point
    const slFile = read('unity/Assets/Muchi/Game/SelfLimitsModel.cs');
    const sl = slFile.slice(slFile.indexOf('class SelfLimitsModel'));
    expect(sl).not.toMatch(/Prompts|TryClaim/);
  });
  it('the prototype claims promotion_outcome and survey through sessionPrompt; the play-time sheet does not', () => {
    const app = read('tools/figma-prototype/site/app.js');
    expect(app).toMatch(/sessionPrompt\.claim\('promotion_outcome'\)/);
    expect(app).not.toMatch(/sessionPrompt\.(claim|can)\('promotion'\)/);
    expect(app).toMatch(/sessionPrompt\.claim\('survey'\)/);
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
