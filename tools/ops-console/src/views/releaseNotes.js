import { get, post } from '../api.js';
import { badge, card, field, h, mount, problemsView, run, table } from '../ui.js';

const KIND_LABEL = { screen: '画面', help: 'ヘルプ記事', tip: 'ヒントのカード' };

/** One language column of a page: title, body (tokens filled) and the target's label. */
function side(p, testid) {
  if (!p) return h('div', { class: 'muted small', 'data-testid': testid }, '（表示できません：検査の問題を直してください）');
  return h('div', { 'data-testid': testid },
    h('strong', {}, p.title),
    h('p', {}, p.body),
    p.target ? h('div', { class: 'muted small' }, `${KIND_LABEL[p.target.kind] ?? p.target.kind}：${p.target.label} ›`) : h('div', { class: 'muted small' }, '行き先なし'));
}

/** The notes of one resolved version, as players see them, in Japanese and English side by side. */
function notesView(r, prefix) {
  if (!r.notes.length) return card(null, h('div', { class: 'empty' }, 'アップデート情報はありません'));
  return r.notes.map((n) => card(`Ver. ${n.appVersion}（${n.releasedOn}）`,
    table([
      { label: 'ページ', value: (p) => String(p.index) },
      { label: '絵', value: (p) => p.art ?? '—' },
      { label: '日本語', value: (p) => side(p.ja, `${prefix}-ja-${n.appVersion}-${p.index}`) },
      { label: 'English', value: (p) => side(p.en, `${prefix}-en-${n.appVersion}-${p.index}`) },
    ], n.pages, { empty: 'ページがありません', testid: `${prefix}-${n.appVersion}` })));
}

/**
 * アップデートのお知らせ (REQ-NEW-016, contracts/protocol.md §64.8): the active version's release notes in both languages
 * (tokens filled, target labels, the server's checks), and a draft `releaseNotes` section checked the same way. Nothing is
 * stored here: a change is a remote-config version (リモート設定) with the `releaseNotes` section.
 */
export async function releaseNotesView(main) {
  const data = await get('/v1/admin/release-notes');
  const draft = h('textarea', { rows: 12, spellcheck: 'false', 'data-testid': 'rn-draft', placeholder: '{ "version": 1, "config": { … }, "notes": [ { "appVersion": "1.3.0", "releasedOn": "2026-12-01", "pages": [ … ] } ] }' });
  const out = h('div', { 'data-testid': 'rn-preview' });
  const preview = async (e) => {
    let section;
    try { section = JSON.parse(draft.value); } catch { mount(out, h('div', { class: 'alert bad', 'data-testid': 'rn-problems' }, 'JSON として読めません')); return; }
    const r = await run(e.currentTarget, () => post('/v1/admin/release-notes/preview', { releaseNotes: section }));
    if (!r) return;
    mount(out, problemsView(r, 'rn-problems'), ...notesView(r, 'rn-draft'));
  };
  mount(main, h('h1', {}, 'アップデート情報'),
    h('p', { class: 'muted' }, `有効な設定 ${data.versionId}。アプリの版ごとに、更新した人へ1回だけ出す紹介（1〜5ページ）。数字はヘルプと同じ {{トークン}}、「倍」「今だけ」などの言葉や賭けの言葉は使えません。行き先にショップ・スカウトは指定できません。何も配りません（配布はプレゼントボックスの補填で）。変更は「リモート設定」で releaseNotes の区画を持つ版を作って有効にします。`),
    card('有効な版の原稿', h('div', { class: 'row' }, badge(data.enabled ? '表示する' : '止まっている', data.enabled ? 'ok' : 'warn')), problemsView(data, 'rn-active-problems')),
    ...notesView(data, 'rn-active'),
    card('下書きを確かめる（保存しません）',
      field('releaseNotes の区画（JSON）', draft, '有効な版のヘルプ・ヒント・ガチャで検査し、日本語と英語で表示します。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-testid': 'rn-preview-btn', onclick: preview }, 'プレビュー')),
      out));
}
