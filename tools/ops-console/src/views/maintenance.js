import { can, get, post, put } from '../api.js';
import { badge, card, confirmWrite, field, h, jst, kv, mount, problemsView, run, statusKind, table } from '../ui.js';

const GROUPS = ['gacha', 'shop', 'ranked', 'teams', 'events', 'tournaments', 'training', 'time_attack', 'social', 'cups'];
const GROUP_LABEL = { gacha: 'ガチャ', shop: 'ショップ', ranked: 'ランク戦・フレンドルーム', teams: '支部', events: 'イベント', tournaments: '大会', training: '調教', time_attack: 'タイムアタック・週替わり', social: 'フレンド・招待・厩舎・ライバル・おすすめ', cups: '主催カップ', core: 'その他すべて（振り返り・厩舎の整理・次にやること など）' };

/**
 * メンテナンス・強制アップデート (REQ-MNT-011, contracts/protocol.md §46.6). Each change becomes a remote-config version
 * derived from the active one (only `maintenance` replaced), activated now, with the reason in the audit log. Times are JST.
 */
export async function maintenanceView(main) {
  const data = await get('/v1/admin/maintenance');
  const id = h('input', { 'data-testid': 'mnt-id', placeholder: 'm-2026-11-12', pattern: '[a-z0-9_-]{1,40}' });
  const start = h('input', { type: 'datetime-local', 'data-testid': 'mnt-start' });
  const end = h('input', { type: 'datetime-local', 'data-testid': 'mnt-end' });
  const announce = h('input', { type: 'datetime-local', 'data-testid': 'mnt-announce' });
  const all = h('input', { type: 'checkbox', checked: true, 'data-testid': 'mnt-all' });
  const groupBoxes = GROUPS.map((g) => h('input', { type: 'checkbox', value: g, 'data-testid': `mnt-g-${g}` }));
  const ja = h('textarea', { rows: 2, maxlength: 200, 'data-testid': 'mnt-ja', placeholder: '11/12 2:00〜6:00 にメンテナンスを行います。' });
  const en = h('textarea', { rows: 2, maxlength: 400, 'data-testid': 'mnt-en', placeholder: 'Maintenance on 11/12 from 2:00 to 6:00 (JST).' });
  const out = h('div', { 'data-testid': 'mnt-preview' });
  const draft = () => ({
    id: id.value.trim(), startJst: start.value, endJst: end.value, ...(announce.value ? { announceJst: announce.value } : {}),
    scope: all.checked ? 'all' : groupBoxes.filter((b) => b.checked).map((b) => b.value),
    message: { ja: ja.value.trim(), en: en.value.trim() },
  });
  const preview = async (e) => {
    const r = await run(e?.currentTarget, () => post('/v1/admin/maintenance/preview', { window: draft() }));
    if (!r) return null;
    mount(out, problemsView(r, 'mnt-problems'),
      card('バナーのプレビュー', h('div', { class: 'grid2' },
        h('div', { 'data-testid': 'mnt-banner-ja' }, h('div', { class: 'muted small' }, r.banner.ja.label), h('strong', {}, r.banner.ja.times), h('p', {}, r.banner.ja.message)),
        h('div', { 'data-testid': 'mnt-banner-en' }, h('div', { class: 'muted small' }, r.banner.en.label), h('strong', {}, r.banner.en.times), h('p', {}, r.banner.en.message))),
      h('p', { class: 'muted small' }, `止まる機能：${r.window.groups.map((g) => GROUP_LABEL[g] ?? g).join('・')}。購入レシート・ストア通知・退会・進行中のレースの確定は止まりません。お知らせの表示開始：${jst(r.window.announceAt)}`)));
    return r;
  };
  const schedule = async (e) => {
    const btn = e.currentTarget;
    const r = await preview();
    if (!r || !r.ok) return;
    const reason = await confirmWrite({ title: `メンテナンス ${r.window.id} を予定する`, summary: [h('div', {}, `${jst(r.window.startAtMs)} 〜 ${jst(r.window.endAtMs)}`), h('div', { class: 'muted small' }, r.banner.ja.message)], confirmLabel: '予定する' });
    if (!reason) return;
    if (await run(btn, () => post('/v1/admin/maintenance/windows', { window: draft(), reason }), '予定しました（30秒以内に全サーバーへ届きます）')) maintenanceView(main);
  };
  const cancel = (w) => async (e) => {
    const reason = await confirmWrite({ title: `${w.id} を${w.status === 'active' ? '今すぐ終える' : '取り消す'}`, summary: [h('div', {}, `${jst(w.startAtMs)} 〜 ${jst(w.endAtMs)}`)], danger: true, confirmLabel: w.status === 'active' ? '今すぐ終える' : '取り消す' });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`/v1/admin/maintenance/windows/${encodeURIComponent(w.id)}/cancel`, { reason }), '変更しました')) maintenanceView(main);
  };
  const cv = data.clientVersions;
  const vIn = (p, k) => h('input', { value: cv[p][k] ?? '', 'data-testid': `ver-${p}-${k}` });
  const vers = { ios: { min: vIn('ios', 'min'), recommended: vIn('ios', 'recommended'), storeUrl: vIn('ios', 'storeUrl') }, android: { min: vIn('android', 'min'), recommended: vIn('android', 'recommended'), storeUrl: vIn('android', 'storeUrl') } };
  const engine = h('input', { type: 'number', min: 1, value: data.minEngineLevel, 'data-testid': 'ver-engine' });
  const saveVersions = async (e) => {
    const body = { clientVersions: Object.fromEntries(Object.entries(vers).map(([p, x]) => [p, { min: x.min.value.trim(), recommended: x.recommended.value.trim(), storeUrl: x.storeUrl.value.trim() || null }])), minEngineLevel: Number(engine.value) };
    const reason = await confirmWrite({ title: '対応バージョンを変更する', summary: [h('div', {}, `iOS 最低 ${body.clientVersions.ios.min} / 推奨 ${body.clientVersions.ios.recommended}`), h('div', {}, `Android 最低 ${body.clientVersions.android.min} / 推奨 ${body.clientVersions.android.recommended}`), h('div', { class: 'muted small' }, '最低より古いアプリは 426 で更新画面になります（購入レシート・退会は止まりません）。')], danger: true, confirmLabel: '変更する' });
    if (!reason) return;
    if (await run(e.currentTarget, () => put('/v1/admin/maintenance/client-versions', { ...body, reason }), '変更しました')) maintenanceView(main);
  };
  mount(main, h('h1', {}, 'メンテナンス・対応バージョン'),
    h('p', { class: 'muted' }, `有効な設定 ${data.versionId}。デプロイが止める必要のある変更（docs/ops/deploy.md §7.2）はメンテナンスの時間内に出します。終わったら補填は「補填の承認」から gift box の「メンテナンスのお詫び」で。`),
    card('予定・実施中', table([
      { label: 'ID', value: (w) => w.id }, { label: '状態', value: (w) => badge(w.status, statusKind(w.status) || (w.status === 'announced' ? 'warn' : '')) },
      { label: '開始', value: (w) => jst(w.startAtMs) }, { label: '終了', value: (w) => jst(w.effectiveEndAt) }, { label: 'お知らせ', value: (w) => jst(w.announceAt) },
      { label: '範囲', value: (w) => (w.scope === 'all' ? 'すべて' : w.scope.map((g) => GROUP_LABEL[g] ?? g).join('・')) },
      { label: 'メッセージ', value: (w) => w.message.ja },
      { label: '', value: (w) => ((w.status === 'scheduled' || w.status === 'announced' || w.status === 'active') && can('admin') ? h('button', { class: 'btn small danger', 'data-testid': `mnt-cancel-${w.id}`, onclick: cancel(w) }, w.status === 'active' ? '今すぐ終える' : '取り消す') : null) },
    ], data.windows, { empty: 'メンテナンスの予定はありません', testid: 'mnt-table' })),
    card('新しいメンテナンス（日本時間）',
      h('div', { class: 'row' }, field('ID', id), field('開始', start), field('終了', end), field('お知らせ開始（省略＝24時間前）', announce)),
      h('div', { class: 'row' }, h('label', {}, all, ' すべて止める'), groupBoxes.map((b) => h('label', {}, b, ` ${GROUP_LABEL[b.value]}`))),
      field('メッセージ（日本語）', ja), field('メッセージ（英語）', en, '両方必須。「倍」「今だけ」などの表現は使えません。'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-testid': 'mnt-preview-btn', onclick: preview }, 'プレビュー'),
        can('admin') ? h('button', { class: 'btn primary', 'data-testid': 'mnt-schedule', onclick: schedule }, '予定する') : null),
      out),
    card('対応バージョン（強制アップデート）',
      kv([['iOS', h('div', { class: 'row' }, field('最低', vers.ios.min), field('推奨', vers.ios.recommended), field('ストアURL', vers.ios.storeUrl))],
        ['Android', h('div', { class: 'row' }, field('最低', vers.android.min), field('推奨', vers.android.recommended), field('ストアURL', vers.android.storeUrl))],
        ['エンジン', field('最低レベル', engine, 'ランク戦・イベント・大会・タイムアタックに入れる最低のエンジン（protocol §4 hello.engine）')]], 'ver-table'),
      can('admin') ? h('button', { class: 'btn primary', 'data-testid': 'ver-save', onclick: saveVersions }, '変更する') : null));
}
