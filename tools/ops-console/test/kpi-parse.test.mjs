import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKpiQueries, slugOf } from '../src/kpi-parse.js';

test('splits sections with their SQL blocks', () => {
  const md = '# T\n\n## 前提\ntext only\n\n## 継続率（D1 / D7）\n説明です。\n```sql\nSELECT 1\n```\n\n## Two\n```sql\nA\n```\n```sql\nB\n```\n';
  assert.deepEqual(parseKpiQueries(md), [
    { title: '継続率（D1 / D7）', anchor: slugOf('継続率（D1 / D7）'), queries: ['SELECT 1'], summary: '説明です。' },
    { title: 'Two', anchor: 'two', queries: ['A', 'B'], summary: '' },
  ]);
});

test('the real kpi-queries.md has queries', () => {
  const s = parseKpiQueries(readFileSync(new URL('../../../docs/ops/kpi-queries.md', import.meta.url), 'utf8'));
  assert.ok(s.length >= 5);
  assert.ok(s.every((x) => x.queries.every((q) => /SELECT/i.test(q))));
});
