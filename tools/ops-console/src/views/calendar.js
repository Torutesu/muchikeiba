import { get } from '../api.js';
import { badge, card, errorBox, field, h, jst, mount, table } from '../ui.js';

const KIND_LABEL = {
  event: 'イベントレース', event_exchange: 'イベント交換所', weekly_challenge: '週替わりチャレンジ', team_goal: '支部の共同目標', league_season: '支部対抗シーズン',
  season: 'ランク戦のシーズン', season_pass: 'シーズンパス（買える月）', banner: 'スカウト', tournament_registration: '大会の受付', tournament: '大会の開始',
  maintenance: 'メンテナンス',
};
const RULE_LABEL = { game_day: 'ゲーム日', calendar_month: '暦の月', exact: '時刻' };
const OVERLAP_LABEL = { maintenance_closes: 'メンテナンスで止まる', same_kind: '同じ種類が重なる' };

/**
 * 予定表 (REQ-CAL-012, contracts/protocol.md §65.3): the merged calendar of a config version for a date range (35 days at
 * most) — events, exchange, weeks, seasons, the pass month, banners (unannounced ones too), tournaments and maintenance
 * windows (scheduled ones too) — and the overlaps to look at before activating: a window that closes a running row's
 * group, two events / banners / tournament registrations at once. Read only; times are JST.
 */
export async function calendarView(main, [versionArg, fromArg]) {
  const cfg = await get('/v1/admin/config');
  const versionId = versionArg ?? 'active';
  const out = h('div', { 'data-testid': 'calendar-out' });
  const from = h('input', { type: 'date', 'data-testid': 'cal-from', value: fromArg ?? '' });
  const pick = h('select', { 'data-testid': 'cal-version' },
    ['active', 'base', ...cfg.versions.map((v) => v.id)].map((id) => h('option', { value: id, selected: id === versionId }, id === 'active' ? `active（${cfg.active.versionId}）` : id)));
  const go = () => { location.hash = `#/calendar/${encodeURIComponent(pick.value)}${from.value ? `/${from.value}` : ''}`; };
  pick.addEventListener('change', go);

  async function load() {
    mount(out, h('div', { class: 'loading' }, '読み込み中…'));
    try {
      const q = new URLSearchParams({ versionId });
      if (fromArg) q.set('from', fromArg);
      const r = await get(`/v1/admin/calendar?${q}`);
      const name = (id) => r.entries.find((e) => e.id === id)?.name ?? id;
      mount(out,
        h('p', { class: 'muted small' }, `${r.from} 〜 ${r.to}（ゲーム日、${r.entries.length} 件）。今日のゲーム日 ${r.today}。時刻は日本時間。${r.partial.length ? `読めなかったもの：${r.partial.join('・')}` : ''}`),
        card(`重なり（${r.overlaps.length}）`, table([
          { label: '種類', value: (o) => badge(OVERLAP_LABEL[o.kind] ?? o.kind, o.kind === 'maintenance_closes' ? 'warn' : '') },
          { label: '予定 A', value: (o) => `${name(o.a)}（${o.a}）` }, { label: '予定 B', value: (o) => `${name(o.b)}（${o.b}）` },
          { label: '重なる時間', value: (o) => `${o.fromJst.replace('T', ' ')} 〜 ${o.toJst.replace('T', ' ')}` },
        ], r.overlaps, { empty: '重なりはありません', testid: 'cal-overlaps' })),
        card(`予定（${r.versionId}）`, table([
          { label: '種類', value: (e) => KIND_LABEL[e.kind] ?? e.kind },
          { label: '名前', value: (e) => e.name ?? '—' },
          { label: '期間', value: (e) => (e.endAt <= e.startAt ? jst(e.startAt) : `${jst(e.startAt)} 〜 ${jst(e.endAt)}`) },
          { label: '日', value: (e) => `${e.firstDay}${e.lastDay !== e.firstDay ? ` 〜 ${e.lastDay}` : ''}（${RULE_LABEL[e.rule] ?? e.rule}）` },
          { label: '状態', value: (e) => badge(e.status, e.status === 'open' ? 'ok' : '') },
          { label: '公開', value: (e) => (e.announced === false ? badge('予告前', 'warn') : '—') },
          { label: '止まる機能', value: (e) => (e.groups ? e.groups.join('・') : '—') },
        ], r.entries, { empty: '予定はありません', testid: 'cal-table' })));
    } catch (e) { mount(out, errorBox(e)); }
  }

  mount(main, h('h1', {}, '予定表'),
    h('div', { class: 'row' }, field('設定の版', pick), field('開始日（ゲーム日・空欄は今日）', from), h('button', { class: 'btn', 'data-testid': 'cal-load', onclick: go }, '表示')),
    h('p', { class: 'muted small' }, 'プレイヤーの予定表と同じ組み立てです（カップ・復帰キャンペーンは本人だけのものなので出しません）。予告前のバナーと予約済みのメンテナンスも出します。変更は設定の版・メンテナンスの画面から。'),
    out);
  await load();
}
