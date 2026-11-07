/**
 * Splits docs/ops/kpi-queries.md into `## ` sections with their SQL blocks (used by build.mjs; pure, also unit tested).
 * The anchor follows GitHub's heading slug rules closely enough for the section links.
 */
export function slugOf(title) {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

export function parseKpiQueries(md) {
  const sections = [];
  let cur = null;
  let inSql = false;
  let buf = [];
  for (const line of md.split('\n')) {
    if (!inSql && line.startsWith('## ')) {
      cur = { title: line.slice(3).trim(), anchor: slugOf(line.slice(3)), queries: [], summary: '' };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!inSql && /^```sql\s*$/.test(line)) { inSql = true; buf = []; continue; }
    if (inSql && /^```\s*$/.test(line)) { inSql = false; cur.queries.push(buf.join('\n')); continue; }
    if (inSql) { buf.push(line); continue; }
    if (!cur.summary && line.trim() && !line.startsWith('|') && !line.startsWith('#')) cur.summary = line.trim().slice(0, 200);
  }
  return sections.filter((s) => s.queries.length > 0);
}
