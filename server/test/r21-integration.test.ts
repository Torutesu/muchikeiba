// Round 21 integration: §62 トレーナーカード, §63 ディープリンク・再戦, §64 アップデートのお知らせ, §65 予定表 against each
// other and against Rounds 17–20 (§46 maintenance, §47 blocks, §48 help, §51 data export, §54 transfer, §57 tips,
// §58 KPI consent and the one-prompt rule, §60 error reports, §61 local notifications, account deletion).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientEventSchema } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, kpiClassOf } from '../src/domain/kpiConsent.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const csFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.cs')).map((f) => read(join(dir, f))).join('\n');

/** Every KPI event Round 21 added (server rows and client events). */
const R21_KPI = {
  showcase: ['showcase_save', 'showcase_view', 'showcase_share'],
  links: ['link_create', 'link_resolve', 'link_revoke', 'rematch', 'deep_link_open'],
  releaseNotes: ['release_notes_view', 'release_notes_target', 'release_notes_history'],
  calendar: ['calendar_view', 'calendar_entry_open', 'calendar_mark'],
};
const ALL_R21_KPI = Object.values(R21_KPI).flat();

describe('§58 KPI classification of the Round 21 events (REQ-CNS-012, §58.7)', () => {
  it('every Round 21 event is classified, and all of them are optional (engagement only; none is a legal / payment / security record)', () => {
    for (const n of ALL_R21_KPI) {
      expect(KPI_EVENT_CLASS[n], n).toBe('optional');
      expect(kpiClassOf(n), n).toBe('optional');
      expect(n in KPI_ESSENTIAL, n).toBe(false);
    }
  });
  it('§58.7 in the protocol lists every Round 21 event with its class', () => {
    const p = read('contracts/protocol.md');
    const s = p.slice(p.indexOf('### 58.7'), p.indexOf('### 58.8'));
    for (const n of ALL_R21_KPI) expect(s, n).toContain(n);
  });
  it('the Round 21 client events are built by Muchi.Client and documented in docs/ops/kpi-queries.md', () => {
    const names = clientEventSchema.options.map((o) => (o.shape.name as unknown as { value: string }).value);
    const cs = csFiles('engine/Muchi.Client');
    const q = read('docs/ops/kpi-queries.md');
    for (const n of ['showcase_view', 'showcase_share', 'deep_link_open', 'release_notes_view', 'release_notes_target', 'release_notes_history', 'calendar_view', 'calendar_entry_open']) {
      expect(names, n).toContain(n);
      expect(cs, n).toContain(`"${n}"`);
    }
    for (const n of ALL_R21_KPI) expect(q, n).toContain(n);
  });
});
