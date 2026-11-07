import { get } from '../api.js';
import { badge, card, field, h, jst, json, mount, table } from '../ui.js';

/** Audit log (REQ-OPS-012/014): who / when / what / before / after, filtered and paged newest first. */
export async function auditView(main) {
  const actor = h('input', { type: 'text', placeholder: 'actor', 'data-testid': 'audit-actor' });
  const target = h('input', { type: 'text', placeholder: 'player:p1 / config:cfg_3', 'data-testid': 'audit-target' });
  const action = h('input', { type: 'text', placeholder: 'compensation.approve', 'data-testid': 'audit-action' });
  const out = h('div');
  let before = null;
  async function load(reset) {
    if (reset) before = null;
    const q = new URLSearchParams({ limit: '50' });
    if (actor.value.trim()) q.set('actor', actor.value.trim());
    if (target.value.trim()) q.set('target', target.value.trim());
    if (action.value.trim()) q.set('action', action.value.trim());
    if (before) q.set('beforeSeq', String(before));
    const r = await get(`/v1/admin/audit?${q}`);
    const rows = r.entries;
    before = rows.length ? rows[rows.length - 1].seq : null;
    const tbl = table([
      { label: '#', value: (e) => e.seq, class: 'num' }, { label: '日時', value: (e) => jst(e.at) },
      { label: '操作者', value: (e) => [e.actor, ' ', badge(e.role, `role-${e.role}`)] }, { label: '操作', value: (e) => h('code', {}, e.action) },
      { label: '対象', value: (e) => e.target ?? '—' }, { label: '理由', value: (e) => e.reason ?? '—' },
      { label: '結果', value: (e) => (e.result === 'ok' ? badge('ok', 'ok') : badge(e.error ?? 'error', 'bad')) },
      { label: '変更', value: (e) => (e.before !== null || e.after !== null ? h('details', {}, h('summary', {}, '前／後'), h('div', { class: 'cols' }, h('div', {}, h('div', { class: 'muted small' }, '変更前'), json(e.before)), h('div', {}, h('div', { class: 'muted small' }, '変更後'), json(e.after)))) : '') },
    ], rows, { empty: '該当なし', testid: 'audit-table' });
    if (reset) mount(out, tbl); else out.append(tbl);
    more.hidden = rows.length < 50;
  }
  const more = h('button', { class: 'btn ghost', hidden: true, onclick: () => load(false) }, 'さらに古いものを読む');
  mount(main, h('h1', {}, '監査ログ'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(true); } }, field('操作者', actor), field('対象', target), field('操作', action), h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'audit-search' }, '絞り込み')),
    card(null, out, more));
  await load(true);
}
