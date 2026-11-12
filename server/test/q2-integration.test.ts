// Quality pass 2 integration (claude/quality-2): ranked (docs/quality/ranked.md), shop (docs/quality/shop.md) and the first
// week (docs/quality/first-week.md) against each other and against the rules they share — the §58.11 one-prompt table
// (account-link timing), §58.7 KPI classification, home says each thing once, the receipt's step vs the first steps'
// screens, one beginner-match strength.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';
import { PATH_SCREENS } from '../src/domain/goals.js';
import { m } from './helpers.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const section = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

describe('§58.11 row 7: the account-link prompt says WHEN in the one table, and C# / the prototype follow it', () => {
  const p = read('contracts/protocol.md');
  const row = section(p, '### 58.11', '## 59.').split('\n').find((l) => l.includes('`account_link`'))!;
  it('the table row names both moments (day 3 after a closed result; the first purchase after the receipt)', () => {
    expect(row).toMatch(/ResultClosed/);
    expect(row).toMatch(/PurchaseComplete/);
    expect(row).toMatch(/受け取りの画面を閉じた後/);
  });
  it('C#: day 3 itself is never the home prompt (from day 4 it is); the prototype asks with ResultClosed after a result and PurchaseComplete when a receipt closes', () => {
    const cs = read('unity/Assets/Muchi/Game/AccountLinkPrompt.cs');
    expect(cs).toMatch(/trigger == LinkPromptTrigger\.Day3 && context == LinkPromptContext\.Home && gameDay <= TriggerDay\) return false/);
    const app = read('tools/figma-prototype/site/app.js');
    expect(app).toMatch(/linkFromResult \? 'ResultClosed' : 'Home'/);
    const receipt = section(app, 'function Receipt(rc)', '/** The receipt\'s one next step');
    expect(receipt).toMatch(/MaybeLinkPrompt\('PurchaseComplete', back\)/);
    expect(section(app, 'function PurchaseConfirm', 'function Receipt(rc)')).toMatch(/linkOp\('purchase'\)/); // NotePurchase on a granted purchase
  });
});

describe('§58.7: quality pass 2 events are classified (optional — screens only; the pull and the purchase stay essential server rows)', () => {
  it('scout_confirm and purchase_receipt are client events, optional, and in the §58.7 table', () => {
    const names = clientEventSchema.options.map((o) => o.shape.name.value as string);
    const s587 = section(read('contracts/protocol.md'), '### 58.7', '### 58.8');
    for (const n of ['scout_confirm', 'purchase_receipt']) {
      expect(names).toContain(n);
      expect(KPI_EVENT_CLASS[n], n).toBe('optional');
      expect(s587).toContain('`' + n + '`');
    }
    for (const n of ['gacha_draw', 'purchase']) expect(kpiClassOf(n)).toBe('essential');
  });
});

describe('home says each thing once: a feature the ladder or menu shows is not announced again (C# = prototype)', () => {
  it('NextActionModel.HomeCoveredFeatures = MuchiLogic.homeCoveredFeatures, and the server lists those features last', () => {
    const cs = read('unity/Assets/Muchi/Game/NextActionModel.cs');
    const csList = JSON.parse('[' + /HomeCoveredFeatures = new\[\] \{ ([^}]+) \}/.exec(cs)![1]! + ']');
    const ts = read('tools/figma-prototype/logic/entry.ts');
    const tsList = JSON.parse(/homeCoveredFeatures: (\[[^\]]+\])/.exec(ts)![1]!.replace(/'/g, '"'));
    expect(csList).toEqual(tsList);
    const order = m.progression.nextActions!.rules.find((r) => r.kind === 'feature_unlocked')!.features!;
    const firstCovered = order.findIndex((f) => tsList.includes(f));
    expect(order.slice(firstCovered).every((f) => tsList.includes(f)), 'covered features come after every feature only the line can announce').toBe(true);
  });
});

describe('shop × first week: the receipt\'s step and the first steps open the same scout screen; neither ever opens the shop', () => {
  it('the first steps\' scout step and the receipt\'s ticket / coin steps are the scout screen', () => {
    expect(PATH_SCREENS.gacha!.screen).toBe('scout');
    for (const v of Object.values(PATH_SCREENS)) expect(['shop', 'store', 'season_pass', 'purchase']).not.toContain(v.screen);
    const cs = read('unity/Assets/Muchi/Game/MonetizationQualityModels.cs');
    expect(cs).toMatch(/case "use_sr_ticket": return Target\.ScoutSrTicket;/);
    expect(cs).toMatch(/case "scout": return Target\.Scout;/);
    const app = read('tools/figma-prototype/site/app.js');
    expect(app).toMatch(/GL_STEP_GO = \{ scout: \(\) => Scout\(\)/);
  });
});

describe('one beginner-match strength (ranked: 860)', () => {
  it('progression.beginnerMatch.cpuStatPermille = 860 = practice "easy" (from beginnerMatch) = the shared practice sample', () => {
    expect(m.progression.beginnerMatch!.cpuStatPermille).toBe(860);
    const sample = JSON.parse(read('contracts/practice-catalog.sample.json'));
    expect(sample.strengths.find((l: { id: string }) => l.id === 'easy').cpuStatPermille).toBe(860);
  });
});
