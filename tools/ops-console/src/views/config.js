import { can, get, post } from '../api.js';
import { badge, card, confirmWrite, errorBox, field, fromJstInput, h, jst, json, mount, problemsView, run, table, toast } from '../ui.js';

/** Remote config (REQ-OPS-002..009): active / pending, versions, diff, draft validation, activation, rollback, cancel. */
export async function configView(main) {
  const data = await get('/v1/admin/config');
  const versions = [...data.versions].reverse();
  const ids = ['base', ...data.versions.map((v) => v.id)];
  const checkOut = h('div', { 'data-testid': 'dryrun-result' });

  /** Dry run first; only a clean dry run opens the confirmation. */
  async function check(op, title) {
    let dry;
    try { dry = await post('/v1/admin/config/dry-run', { op }); } catch (e) { mount(checkOut, errorBox(e)); return null; }
    mount(checkOut, h('div', { class: 'dry-head' }, `事前チェック：${title}`), problemsView(dry, 'dryrun-problems'));
    checkOut.scrollIntoView({ block: 'nearest' });
    return dry;
  }
  async function guarded(op, title, summary, perform, danger = false) {
    const dry = await check(op, title);
    if (!dry) return;
    if (!dry.ok) { toast('事前チェックで問題が見つかりました（実行していません）', 'error'); return; }
    const reason = await confirmWrite({ title, summary: [summary, dry.effect ? h('div', { class: 'muted small' }, `効果：${dry.effect.kind} ${dry.effect.versionId} @ ${jst(dry.effect.at)}`) : null], danger });
    if (!reason) return;
    const out = await run(null, () => perform(reason), `${title}：完了`);
    if (out) configView(main);
  }

  const activeCard = card('有効な設定',
    h('div', { class: 'row' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '有効な版'), h('div', { class: 'stat-value', 'data-testid': 'active-version' }, data.active.versionId)),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '有効化'), h('div', { class: 'stat-value small' }, jst(data.active.since))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '予約'), h('div', { class: 'stat-value' }, String(data.pending.length))),
      h('div', { class: 'spacer' }),
      can('admin') ? h('button', { class: 'btn danger', 'data-testid': 'rollback-prev', onclick: () => guarded({ kind: 'rollback', versionId: null }, '1つ前の版にロールバック', '今すぐ1つ前の版（なければ base）に戻します。', (reason) => post('/v1/admin/config/rollback', { versionId: null, reason }), true) }, '1つ前にロールバック') : null),
    h('h3', {}, '予約中の有効化'),
    table([
      { label: 'ID', value: (a) => a.id }, { label: '版', value: (a) => a.versionId }, { label: '時刻', value: (a) => jst(a.at) },
      { label: '種別', value: (a) => a.kind }, { label: '実行者', value: (a) => a.by }, { label: '理由', value: (a) => a.reason },
      { label: '', value: (a) => (can('admin') ? h('button', { class: 'btn small', 'data-testid': `cancel-${a.id}`, onclick: () => guarded({ kind: 'cancel', activationId: a.id }, `予約 ${a.id} を取り消し`, `${jst(a.at)} の ${a.versionId} の有効化を取り消します。`, (reason) => post(`/v1/admin/config/activations/${encodeURIComponent(a.id)}/cancel`, { reason })) }, '取り消し') : '') },
    ], data.pending, { empty: '予約はありません', testid: 'pending-table' }),
    checkOut);

  const versionsCard = card('版',
    table([
      { label: 'ID', value: (v) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); showBundle(v.id); } }, v.id) },
      { label: '作成', value: (v) => jst(v.createdAt) }, { label: '作成者', value: (v) => v.createdBy }, { label: 'メモ', value: (v) => v.note || '—' },
      { label: 'ruleset', value: (v) => v.rulesetVersion }, { label: 'hash', value: (v) => h('code', {}, v.hash.slice(0, 12)) },
      { label: '状態', value: (v) => (v.id === data.active.versionId ? badge('active', 'ok') : data.pending.some((p) => p.versionId === v.id) ? badge('pending', 'warn') : '') },
      { label: '', value: (v) => h('div', { class: 'actions' },
        h('button', { class: 'btn small ghost', 'data-testid': `dry-${v.id}`, onclick: () => check({ kind: 'activate', versionId: v.id, ...(fromJstInput(at.value) ? { at: fromJstInput(at.value) } : {}) }, `${v.id} の有効化`) }, '事前チェック'),
        can('admin') ? h('button', { class: 'btn small', 'data-testid': `activate-${v.id}`, onclick: () => activate(v.id) }, '有効化…') : null,
        can('admin') && v.id !== data.active.versionId ? h('button', { class: 'btn small danger', onclick: () => guarded({ kind: 'rollback', versionId: v.id }, `${v.id} にロールバック`, `今すぐ ${v.id} に戻します。`, (reason) => post('/v1/admin/config/rollback', { versionId: v.id, reason }), true) }, 'ここに戻す') : null) },
    ], versions, { empty: '登録された版はありません（base のまま）', testid: 'versions-table' }));

  const at = h('input', { type: 'datetime-local', 'data-testid': 'activate-at' });
  async function activate(id) {
    const when = fromJstInput(at.value);
    await guarded({ kind: 'activate', versionId: id, ...(when ? { at: when } : {}) }, `${id} を${when ? ` ${jst(when)} に` : '今すぐ'}有効化`, '全プレイヤーに配信されます（30秒以内）。', (reason) => post('/v1/admin/config/activations', { versionId: id, ...(when ? { at: when } : {}), reason }));
  }
  versionsCard.append(h('div', { class: 'row' }, field('有効化の予約時刻（JST、空欄＝今すぐ）', at)));

  // ---- diff
  const from = h('select', { 'data-testid': 'diff-from' }, ids.map((id) => h('option', { value: id }, id)));
  const to = h('select', { 'data-testid': 'diff-to' }, ids.map((id) => h('option', { value: id }, id)));
  if (ids.length > 1) { from.value = data.active.versionId; to.value = ids[ids.length - 1]; }
  const diffOut = h('div', { 'data-testid': 'diff-result' });
  const diffCard = card('版の比較',
    h('div', { class: 'row' }, field('比較元', from), field('比較先', to),
      h('button', { class: 'btn', 'data-testid': 'diff-run', onclick: async () => {
        try {
          const d = await get(`/v1/admin/config/diff?from=${encodeURIComponent(from.value)}&to=${encodeURIComponent(to.value)}`);
          mount(diffOut, h('div', { class: 'muted small' }, `${d.total} 件の差分${d.truncated ? '（先頭500件）' : ''}`), table([
            { label: 'パス', value: (c) => h('code', {}, c.path) },
            { label: '変更前', value: (c) => h('pre', { class: 'json small del' }, JSON.stringify(c.before, null, 1)) },
            { label: '変更後', value: (c) => h('pre', { class: 'json small add' }, JSON.stringify(c.after, null, 1)) },
          ], d.changes, { empty: '差分なし', testid: 'diff-table' }));
        } catch (e) { mount(diffOut, errorBox(e)); }
      } }, '比較')), diffOut);

  // ---- draft
  const draft = h('textarea', { class: 'code', rows: 12, spellcheck: 'false', 'data-testid': 'draft', placeholder: '{ "gacha": { "banners": [ … ] } }  — バンドル（部分）JSON' });
  const note = h('input', { type: 'text', maxlength: 500, placeholder: 'メモ（版の一覧に表示）', 'data-testid': 'draft-note' });
  const draftOut = h('div', { 'data-testid': 'validate-result' });
  const parseDraft = () => {
    try { return JSON.parse(draft.value || '{}'); } catch (e) { mount(draftOut, errorBox({ code: 'JSON', message: e.message })); return null; }
  };
  const draftCard = card('下書きの検証・登録',
    h('p', { class: 'muted small' }, '検証はサーバーで、起動時と同じ検証器（ルールセット・ガチャ・コース・ゲーム日・アセットカタログ…）を実行します。何も保存しません。'),
    draft, field('メモ', note),
    h('div', { class: 'row' },
      h('button', { class: 'btn', 'data-testid': 'validate', onclick: async (e) => {
        const bundle = parseDraft(); if (!bundle) return;
        const r = await run(e.currentTarget, () => post('/v1/admin/config/validate', { bundle }));
        if (r) mount(draftOut, problemsView(r, 'validate-problems'));
      } }, '検証（ドライラン）'),
      can('operator') ? h('button', { class: 'btn primary', 'data-testid': 'stage', onclick: async () => {
        const bundle = parseDraft(); if (!bundle) return;
        const v = await post('/v1/admin/config/validate', { bundle }).catch((e) => ({ problems: [e.message] }));
        mount(draftOut, problemsView(v, 'validate-problems'));
        if (v.problems.length) return;
        const reason = await confirmWrite({ title: '版を登録', summary: '検証済みのバンドルを新しい版として保存します（有効化は別の操作）。' });
        if (!reason) return;
        const out = await run(null, () => post('/v1/admin/config/versions', { bundle, note: note.value, reason }), (o) => `${o.version.id} を${o.created ? '登録' : '既存の版として確認'}しました`);
        if (out) configView(main);
      } }, '版として登録') : null),
    draftOut);

  const bundleOut = h('div', { 'data-testid': 'bundle-view' });
  async function showBundle(id) {
    try { const v = await get(`/v1/admin/config/versions/${encodeURIComponent(id)}`); mount(bundleOut, h('h3', {}, `${id} の本体`), json(v.bundle)); bundleOut.scrollIntoView({ block: 'nearest' }); } catch (e) { mount(bundleOut, errorBox(e)); }
  }

  const historyCard = card('有効化の履歴', table([
    { label: 'ID', value: (a) => a.id }, { label: '版', value: (a) => a.versionId }, { label: '時刻', value: (a) => jst(a.at) }, { label: '種別', value: (a) => a.kind },
    { label: '状態', value: (a) => (a.cancelled ? badge('cancelled', 'muted') : a.at > Date.now() ? badge('pending', 'warn') : badge('done', 'ok')) },
    { label: '実行者', value: (a) => a.by }, { label: '理由', value: (a) => a.reason },
  ], [...data.activations].reverse(), { empty: '履歴なし' }));

  mount(main, h('h1', {}, 'リモート設定'), activeCard, versionsCard, bundleOut, diffCard, draftCard, historyCard);
}
