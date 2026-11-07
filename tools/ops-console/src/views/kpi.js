import { config } from '../api.js';
import { card, h, mount, toast } from '../ui.js';

/**
 * KPI quick view: the queries of docs/ops/kpi-queries.md (embedded at build time) with links to the doc. The queries
 * run in the Cloudflare Analytics Engine SQL API with an account token the console never sees.
 */
export async function kpiView(main) {
  const res = await fetch('kpi.json', { cache: 'no-store' });
  const kpi = await res.json();
  const doc = `${config.docsBase}/${kpi.source}`;
  mount(main, h('h1', {}, 'KPI クエリ'),
    h('p', { class: 'muted' }, 'Workers Analytics Engine の SQL API で実行します（Account Analytics:Read のトークンが必要。コンソールは保持しません）。 ',
      h('a', { href: doc, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'kpi-doc' }, kpi.source)),
    h('nav', { class: 'toc' }, kpi.sections.map((s) => h('a', { href: `${doc}#${s.anchor}`, target: '_blank', rel: 'noopener noreferrer' }, s.title))),
    kpi.sections.map((s) => card(s.title,
      s.summary ? h('p', { class: 'muted small' }, s.summary) : null,
      s.queries.map((q) => h('div', { class: 'sql' }, h('pre', { class: 'json' }, q),
        h('button', { class: 'btn small ghost', onclick: async () => { try { await navigator.clipboard.writeText(q); toast('コピーしました', 'ok'); } catch { toast('コピーできませんでした', 'error'); } } }, 'SQLをコピー'))),
      h('a', { class: 'small', href: `${doc}#${s.anchor}`, target: '_blank', rel: 'noopener noreferrer' }, 'ドキュメントで開く'))));
}
