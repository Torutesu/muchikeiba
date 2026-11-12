// Round 22 integration: §66 騎手の道, §67 使いすぎ・遊びすぎの防止, §68 昇級戦と降級の猶予, §69 ゲーム内アンケート against each
// other and against Rounds 17–21 (§46 maintenance, §48 help, §51 data export, §54 transfer / AccountChangeReset, §57 tips,
// §58 KPI consent and the one-prompt rule, §60 error reports, §61 local notifications, §63 deep links, §65 calendar, deletion).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';

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
