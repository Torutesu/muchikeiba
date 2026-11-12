import { can, get, post, put } from '../api.js';
import { badge, card, confirmWrite, field, fromJstInput, h, jst, kv, mount, num, problemsView, run, statusKind, table, toJstInput } from '../ui.js';

/**
 * アンケート (REQ-SURVEY-015..018, contracts/protocol.md §69.7). The list, a draft editor (the definition as JSON, checked by
 * the server: both languages, betting / pressure words, NG names, reward keys) with the JA / EN preview, publishing a window
 * (admin), closing early, and the live results: counts, percentages, scale averages and the free texts — never with a player
 * id — with a moderation hide (operator) and the CSV. Nothing is ever granted for answering.
 */
const STATUS = { draft: '下書き', scheduled: '予定', live: '公開中', ended: '終了' };
const KIND = { single: '1つ選ぶ', multi: 'いくつでも', scale: '1〜5', text: '自由な文' };
const TEMPLATE = {
  id: 'sv_example', title: { ja: '題', en: 'Title' }, intro: { ja: '短い質問です。', en: 'A few short questions.' },
  targeting: { minRankedRaces: 5 },
  questions: [
    { id: 'feel', kind: 'scale', required: true, text: { ja: '質問', en: 'Question' }, labels: { low: { ja: '低い', en: 'Low' }, high: { ja: '高い', en: 'High' } } },
    { id: 'pick', kind: 'single', required: true, text: { ja: '質問', en: 'Question' }, options: [{ id: 'a', text: { ja: 'A', en: 'A' } }, { id: 'b', text: { ja: 'B', en: 'B' } }] },
    { id: 'free', kind: 'text', required: false, maxLength: 200, text: { ja: 'ひとことあれば', en: 'Anything else?' } },
  ],
};
const statusBadge = (s) => badge(STATUS[s] ?? s, statusKind(s === 'live' ? 'active' : s));

export async function surveysView(main, [id]) {
  if (id === 'new') return editorView(main, null);
  if (id) return detailView(main, id);
  const list = await get('/v1/admin/surveys');
  mount(main, h('h1', {}, 'アンケート'),
    h('p', { class: 'muted' }, '運営からプレイヤーへの短いアンケート。答えても何も配りません。スキップされたアンケートはその人には二度と出ません。自由な文はプレイヤー ID なしで表示します。'),
    can('operator') ? h('p', {}, h('a', { class: 'btn primary', href: '#/surveys/new', 'data-testid': 'sv-new' }, '新しいアンケート')) : null,
    card(null, table([
      { label: '状態', value: (s) => statusBadge(s.status) },
      { label: 'アンケート', value: (s) => h('a', { href: `#/surveys/${encodeURIComponent(s.id)}`, 'data-testid': `sv-open-${s.id}` }, `${s.title.ja}（${s.id}）`) },
      { label: '問い', value: (s) => num(s.questions), class: 'num' },
      { label: '窓（JST）', value: (s) => (s.startAt ? `${jst(s.startAt)} 〜 ${jst(s.closedAt && s.closedAt < s.endAt ? s.closedAt : s.endAt)}` : '—') },
      { label: '答え', value: (s) => num(s.answers), class: 'num' },
      { label: '更新', value: (s) => `${jst(s.updatedAt)} ${s.updatedBy}` },
    ], list, { empty: 'アンケートはまだありません', testid: 'sv-table' })));
}

/** The draft editor (new, or a draft at `rev`). */
function editorView(main, cur) {
  const text = h('textarea', { rows: 26, class: 'code', spellcheck: 'false', 'data-testid': 'sv-json' }, JSON.stringify(cur?.def ?? TEMPLATE, null, 2));
  const out = h('div');
  const parse = () => { try { return JSON.parse(text.value); } catch (e) { mount(out, h('div', { class: 'alert bad', 'data-testid': 'sv-problems' }, `JSON: ${e.message}`)); return null; } };
  const check = async (btn) => {
    const def = parse(); if (!def) return null;
    const r = await run(btn, () => post('/v1/admin/surveys/validate', { survey: def }));
    if (!r) return null;
    mount(out, problemsView(r, 'sv-problems'), r.preview ? previewView(r.preview) : null);
    return r.problems.length ? null : def;
  };
  const save = async (e) => {
    const btn = e.currentTarget;
    const def = await check(btn); if (!def) return;
    const reason = await confirmWrite({ title: cur ? `${cur.id} の下書きを保存する` : `${def.id} を下書きとして作る`, summary: [h('div', {}, def.title.ja), h('div', { class: 'muted small' }, `${def.questions.length} 問 · 公開は admin が窓を決めて行います`)], confirmLabel: '保存する' });
    if (!reason) return;
    const r = await run(btn, () => (cur ? put(`/v1/admin/surveys/${encodeURIComponent(cur.id)}`, { survey: def, rev: cur.rev, reason }) : post('/v1/admin/surveys', { survey: def, reason })), '下書きを保存しました');
    if (r) location.hash = `#/surveys/${encodeURIComponent(r.id)}`;
  };
  mount(main, h('p', {}, h('a', { href: cur ? `#/surveys/${encodeURIComponent(cur.id)}` : '#/surveys' }, '← アンケート')),
    h('h1', {}, cur ? `${cur.id} を直す（rev ${cur.rev}）` : '新しいアンケート'),
    h('p', { class: 'muted' }, '定義は JSON（contracts/protocol.md §69.1）。1〜5 問、種類は single / multi / scale / text、文言は日本語と英語の両方。賭けの言葉・煽りの言葉・NG の名前・報酬のキーはサーバーの検査で落ちます。'),
    field('定義', text),
    h('div', { class: 'row' },
      h('button', { class: 'btn', 'data-testid': 'sv-validate', onclick: (e) => check(e.currentTarget) }, '検査とプレビュー'),
      can('operator') ? h('button', { class: 'btn primary', 'data-testid': 'sv-save', onclick: save }, '下書きを保存') : null),
    out);
}

/** What the player sees, in both languages (the server's view of each). */
function previewView(p) {
  const one = (v, lang) => h('div', { class: 'sv-preview', 'data-testid': `sv-preview-${lang}` },
    h('h3', {}, v.title), v.intro ? h('p', { class: 'muted' }, v.intro) : null,
    h('ol', {}, v.questions.map((q) => h('li', {},
      h('div', {}, h('strong', {}, q.text), ' ', badge(KIND[q.kind] ?? q.kind), q.required ? '' : badge('任意', 'muted')),
      q.options ? h('div', { class: 'small' }, q.options.map((o) => o.text).join(' / ') + (q.kind === 'multi' ? `（${q.maxChoices}つまで）` : '')) : null,
      q.labels ? h('div', { class: 'small' }, `1 = ${q.labels.low} … 5 = ${q.labels.high}`) : null,
      q.kind === 'text' ? h('div', { class: 'small muted' }, `${q.maxLength} 字まで`) : null))));
  return card('プレビュー', h('div', { class: 'row' }, one(p.ja, 'ja'), one(p.en, 'en')));
}

async function detailView(main, id) {
  const s = await get(`/v1/admin/surveys/${encodeURIComponent(id)}`);
  if (s.status === 'draft' && location.hash.endsWith('/edit')) return editorView(main, s);
  const actions = [];
  if (s.status === 'draft' && can('operator')) actions.push(h('a', { class: 'btn', href: `#/surveys/${encodeURIComponent(id)}/edit`, 'data-testid': 'sv-edit' }, '下書きを直す'));
  let publishForm = null;
  if (s.status === 'draft' && can('admin')) {
    const now = Date.now();
    const start = h('input', { type: 'datetime-local', value: toJstInput(now + 5 * 60_000), 'data-testid': 'sv-start' });
    const end = h('input', { type: 'datetime-local', value: toJstInput(now + 7 * 86_400_000), 'data-testid': 'sv-end' });
    publishForm = card('公開する（admin）', h('div', { class: 'row' }, field('開始（JST）', start), field('終了（JST）', end, '90 日まで')),
      h('button', { class: 'btn primary', 'data-testid': 'sv-publish', onclick: async (e) => {
        const startAt = fromJstInput(start.value), endAt = fromJstInput(end.value);
        const reason = await confirmWrite({ title: `${id} を公開する`, summary: [h('div', {}, `${jst(startAt)} 〜 ${jst(endAt)}`), h('div', { class: 'muted small' }, '公開後は質問を変えられません。プレイヤーの経路には30秒以内に届きます。')], confirmLabel: '公開する' });
        if (!reason) return;
        if (await run(e.currentTarget, () => post(`/v1/admin/surveys/${encodeURIComponent(id)}/publish`, { startAt, endAt, reason }), '公開しました')) detailView(main, id);
      } }, '公開する'));
  }
  if ((s.status === 'live' || s.status === 'scheduled') && can('admin')) {
    actions.push(h('button', { class: 'btn danger', 'data-testid': 'sv-close', onclick: async (e) => {
      const reason = await confirmWrite({ title: `${id} を終了する`, summary: [h('div', {}, '端末には「このアンケートは終了しました」とだけ出ます。答えは残ります。')], danger: true, confirmLabel: '終了する' });
      if (!reason) return;
      if (await run(e.currentTarget, () => post(`/v1/admin/surveys/${encodeURIComponent(id)}/close`, { reason }), '終了しました')) detailView(main, id);
    } }, '終了する'));
  }
  const results = s.status === 'draft' ? null : await get(`/v1/admin/surveys/${encodeURIComponent(id)}/results`);
  mount(main, h('p', {}, h('a', { href: '#/surveys' }, '← アンケート')),
    h('h1', {}, statusBadge(s.status), ' ', s.title.ja, h('span', { class: 'muted small' }, `　${s.id} · rev ${s.rev}`)),
    actions.length ? h('div', { class: 'row' }, actions) : null,
    card('概要', kv([['状態', STATUS[s.status]], ['窓（JST）', s.startAt ? `${jst(s.startAt)} 〜 ${jst(s.endAt)}` : '未公開'], ['早く閉じた', s.closedAt ? jst(s.closedAt) : '—'],
      ['出す場所', 'お知らせの中の行だけ（割り込まない・ホームに出さない）'], ['対象', JSON.stringify(s.def.targeting)],
      ['作成', `${jst(s.createdAt)} ${s.createdBy}`], ['公開', s.publishedAt ? `${jst(s.publishedAt)} ${s.publishedBy}` : '—']], 'sv-summary')),
    publishForm,
    results ? resultsView(main, id, results) : card('質問', h('ol', {}, s.def.questions.map((q) => h('li', {}, `${q.text.ja}（${KIND[q.kind]}）`)))));
}

function resultsView(main, id, r) {
  const csv = h('button', { class: 'btn', 'data-testid': 'sv-csv', onclick: async (e) => {
    const btn = e.currentTarget;
    const out = await run(btn, () => get(`/v1/admin/surveys/${encodeURIComponent(id)}/results.csv`));
    if (!out) return;
    const a = h('a', { href: URL.createObjectURL(new Blob(['\ufeff' + out.csv], { type: 'text/csv;charset=utf-8' })), download: out.filename, 'data-testid': 'sv-csv-link' }, out.filename);
    btn.parentNode.querySelector('[data-testid="sv-csv-link"]')?.remove();
    btn.after(a); a.click();
  } }, 'CSV をダウンロード');
  const q = (x) => {
    const head = h('div', {}, h('strong', {}, x.text.ja), ' ', badge(KIND[x.kind]), h('span', { class: 'muted small' }, `　答え ${num(x.answered)} · 未回答 ${num(x.skipped)}`));
    if (x.options) return card(null, head, table([{ label: '選択肢', value: (o) => o.text.ja }, { label: '数', value: (o) => num(o.count), class: 'num' }, { label: '割合', value: (o) => `${o.pct}%`, class: 'num' }], x.options, { testid: `sv-q-${x.id}` }));
    if (x.scale) return card(null, head, h('div', { 'data-testid': `sv-avg-${x.id}` }, `平均 ${x.scale.average ?? '—'}（1 = ${x.labels.low.ja} … 5 = ${x.labels.high.ja}）`),
      table([{ label: '値', value: (row) => String(row.n) }, { label: '数', value: (row) => num(row.c), class: 'num' }, { label: '割合', value: (row) => `${row.p}%`, class: 'num' }], x.scale.counts.map((c, i) => ({ n: i + 1, c, p: x.scale.pct[i] })), { testid: `sv-q-${x.id}` }));
    return card(null, head, table([
      { label: '日時', value: (t) => jst(t.at) },
      { label: '文（スクラブ済み・プレイヤー ID なし）', value: (t) => (t.hidden ? h('span', { class: 'muted' }, '（隠しています）') : t.text) },
      { label: '', value: (t) => (can('operator') ? h('button', { class: 'btn small ghost', 'data-testid': `sv-hide-${t.ref}`, onclick: async (e) => {
        const reason = await confirmWrite({ title: t.hidden ? 'この文を戻す' : 'この文を隠す', summary: [h('div', {}, t.text)], confirmLabel: t.hidden ? '戻す' : '隠す' });
        if (!reason) return;
        if (await run(e.currentTarget, () => post(`/v1/admin/surveys/${encodeURIComponent(id)}/texts/${encodeURIComponent(t.ref)}/hide`, { hidden: !t.hidden, reason }), '変更しました')) detailView(main, id);
      } }, t.hidden ? '戻す' : '隠す') : null) },
    ], x.texts, { empty: '自由な文はありません', testid: `sv-q-${x.id}` }));
  };
  return h('div', { 'data-testid': 'sv-results' },
    card('結果', kv([['答え', num(r.total)], ['区分のある答え（分析オン）', num(r.segmented)], ['区分なし（分析オフ）', num(r.unsegmented)],
      ['プラットフォーム', Object.entries(r.platforms).filter(([, v]) => v).map(([k, v]) => `${k} ${num(v)}`).join(' / ') || '—']], 'sv-totals'), csv),
    r.questions.map(q));
}
