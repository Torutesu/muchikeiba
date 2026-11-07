/**
 * DOM helpers. Server data is only ever inserted as text (textContent / attributes), never as HTML, so a player name or
 * a config note cannot inject markup into the console.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'style') { // CSSOM, not the style attribute: the CSP has no 'unsafe-inline'
      for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
    }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...children) => { clear(el); append(el, children); return el; };

const JST = 9 * 3600_000;
/** "2026-11-10 12:00 JST" (the game and the store reports are in JST). */
export function jst(ms) {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(ms + JST).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} JST`;
}
export const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ja-JP'));
export const yen = (n) => (n === null || n === undefined ? '—' : `¥${Number(n).toLocaleString('ja-JP')}`);

/** A `datetime-local` value read as JST → epoch ms. */
export function fromJstInput(v) {
  if (!v) return null;
  const [d, t] = v.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm] = (t ?? '00:00').split(':').map(Number);
  return Date.UTC(y, mo - 1, da, hh, mm) - JST;
}
export function toJstInput(ms) { return new Date(ms + JST).toISOString().slice(0, 16); }

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
export const statusKind = (s) => ({ active: 'ok', executed: 'ok', ok: 'ok', confirmed: 'ok', registration: 'ok', running: 'ok', pending: 'warn', upcoming: 'warn', scheduled: 'warn', approved: 'warn', quarantined: 'warn', hidden: 'muted', ended: 'muted', finished: 'muted', expired: 'muted', cancelled: 'muted', rejected: 'bad', banned: 'bad', error: 'bad' }[s] ?? '');

/** columns: [{ label, value: (row) => node|string, class? }] */
export function table(columns, rows, { empty = 'データなし', testid } = {}) {
  if (!rows.length) return h('div', { class: 'empty', 'data-testid': testid }, empty);
  return h('div', { class: 'table-wrap' }, h('table', { 'data-testid': testid },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.class }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.class }, c.value(r))))))));
}

export function kv(pairs, testid) {
  return h('dl', { class: 'kv', 'data-testid': testid }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}

export function card(title, ...body) {
  return h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...body);
}

export function json(v) { return h('pre', { class: 'json' }, JSON.stringify(v, null, 2)); }

export function toast(message, kind = 'info') {
  const root = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', 'data-testid': `toast-${kind}` }, message);
  root.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
}

export function errorBox(e) {
  return h('div', { class: 'alert bad', role: 'alert', 'data-testid': 'error' }, h('strong', {}, e.code ?? 'ERROR'), ' ', e.message ?? String(e));
}

/** Validation problems grouped like the server's groupProblems (day rule / asset catalog / gacha / ruleset / other). */
const GROUP_LABEL = { dayRule: 'ゲーム日の切り替え（REQ-DAY-002）', assetCatalog: 'アセットカタログ（REQ-DLV-005）', gacha: 'ガチャ（提供割合・天井・ステップアップ）', ruleset: 'ルールセット', other: 'その他' };
export function problemsView(result, testid = 'problems') {
  if (!result) return null;
  if (result.ok || (result.problems && result.problems.length === 0)) return h('div', { class: 'alert ok', 'data-testid': testid }, '問題なし（サーバー側の検証をすべて通過）');
  const groups = result.groups ?? { other: result.problems };
  return h('div', { class: 'alert bad', 'data-testid': testid },
    h('strong', {}, `${result.problems.length} 件の問題`),
    Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => h('div', { class: 'problem-group', 'data-group': k },
      h('div', { class: 'problem-title' }, GROUP_LABEL[k] ?? k), h('ul', {}, v.map((p) => h('li', {}, p))))));
}

/**
 * Every write goes through this dialog: what will happen, a mandatory reason (3–500 chars, stored in the audit log),
 * and an explicit confirm. Resolves with the reason, or null when cancelled.
 */
export function confirmWrite({ title, summary, danger = false, confirmLabel = '実行', extra = null }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const reason = h('textarea', { rows: 3, maxlength: 500, placeholder: '理由（監査ログに残ります。3〜500文字）', 'data-testid': 'reason' });
    const err = h('div', { class: 'field-error' });
    const close = (v) => { clear(root); resolve(v); };
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, 'data-testid': 'confirm', onclick: () => {
      const r = reason.value.trim();
      if (r.length < 3) { err.textContent = '理由は3文字以上で入力してください'; reason.focus(); return; }
      close(r);
    } }, confirmLabel);
    const dlg = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === dlg) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', {}, title), h('div', { class: 'modal-summary' }, summary), extra,
        h('label', { class: 'field' }, h('span', {}, '理由'), reason), err,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn ghost', 'data-testid': 'cancel', onclick: () => close(null) }, 'キャンセル'), ok)));
    mount(root, dlg);
    reason.focus();
  });
}

/** Runs an async write with busy state and a toast; returns the result or null on error. */
export async function run(btn, fn, okMessage) {
  if (btn) btn.disabled = true;
  try {
    const out = await fn();
    if (okMessage) toast(typeof okMessage === 'function' ? okMessage(out) : okMessage, 'ok');
    return out;
  } catch (e) {
    toast(`${e.code ?? 'ERROR'}: ${e.message}`, 'error');
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}
