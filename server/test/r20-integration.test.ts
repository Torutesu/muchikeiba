// Round 20 integration: §58 広告・分析の同意, §59 レビュー依頼, §60 クライアントのエラー報告, §61 端末のローカル通知 against
// each other and against Rounds 17–19 (§46 maintenance, §48 help, §51 data export, §54 transfer, §57 tips, account deletion, KPI).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, kpiClassOf } from '../src/domain/kpiConsent.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');

describe('§58 KPI classification of the Round 19 / 20 events (REQ-CNS-012, §58.7)', () => {
  it('transfer events are essential (account access audit), engagement events optional', () => {
    for (const n of ['transfer_issue', 'transfer_redeem', 'consent_change']) expect(kpiClassOf(n), n).toBe('essential');
    for (const n of ['cheer_send', 'cheer_seen', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view', 'tip_context_open',
      'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer', 'lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) {
      expect(kpiClassOf(n), n).toBe('optional');
      expect(n in KPI_ESSENTIAL, n).toBe(false);
    }
  });
  it('§58.7 in the protocol lists every Round 19 / 20 event with its class', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ['transfer_issue', 'transfer_redeem', 'cheer_send', 'cheer_seen', 'perf_setting_change', 'asset_predownload', 'tutorial_replay', 'tip_view',
      'tip_context_open', 'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer', 'lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) expect(s, n).toContain(n);
  });
});

describe('KPI: every client event has a C# constructor, a query and a §58 class (cross-check incl. Round 20)', () => {
  const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
  it('Round 20 client events are in the schema', () => {
    for (const n of ['lnotif_scheduled', 'lnotif_opened', 'lnotif_permission']) expect(names).toContain(n);
  });
  it('each client event is built by Muchi.Client, documented in docs/ops/kpi-queries.md and optional (§58.7: clients send no essential event)', () => {
    const cs = csFiles('engine/Muchi.Client');
    const q = read('docs/ops/kpi-queries.md');
    expect(names.filter((n) => !cs.includes(`"${n}"`))).toEqual([]);
    expect(names.filter((n) => !q.includes(n))).toEqual([]);
    expect(names.map((n) => (n === 'race_start' ? 'client_race_start' : n)).filter((n) => kpiClassOf(n) !== 'optional')).toEqual([]);
  });
  it('the server events of Round 20 are documented too', () => {
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['consent_change', 'review_prompt_eligible', 'review_prompt_shown', 'review_soft_answer']) expect(q, n).toContain(n);
  });
});
