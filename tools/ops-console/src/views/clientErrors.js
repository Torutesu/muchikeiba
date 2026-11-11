import { get } from '../api.js';
import { badge, card, field, h, jst, kv, mount, num, table } from '../ui.js';

/**
 * クライアントのエラー (REQ-CERR-014..016, contracts/protocol.md §60.7). Top errors by fingerprint (normalised stack hash),
 * app version, platform, first / last seen, counts and the newest samples. A desync sample links to the race replay and
 * the verifier's integrity events (fairness). Read only; every view is in the audit log. Samples are scrubbed on the device
 * and again on the server: no emails, tokens, player names or free text; a player id only when the device allowed it.
 */
const CATEGORY = { exception: ['例外', 'bad'], api: ['API の失敗', 'warn'], desync: ['レースのズレ', 'bad'], asset: ['アセット', 'warn'], stall: ['固まり', 'muted'] };
const SORT = { count: '数の多い順', last: '最後に見た順', new: '最初に見た順' };
const catBadge = (c) => badge(CATEGORY[c]?.[0] ?? c, CATEGORY[c]?.[1] ?? '');
const versions = (vs) => vs.slice(0, 3).map((v) => `${v.appVersion} (${num(v.count)})`).join(', ') + (vs.length > 3 ? ` ほか${vs.length - 3}` : '');
const platforms = (p) => Object.entries(p ?? {}).map(([k, v]) => `${k} ${num(v)}`).join(' / ');

export async function clientErrorsView(main, [category = '', sort = 'count', fingerprint]) {
  if (fingerprint) return clientErrorDetailView(main, category, sort, fingerprint);
  const qs = new URLSearchParams({ sort, limit: '100', ...(category ? { category } : {}) });
  const data = await get(`/v1/admin/client-errors?${qs}`);
  const go = (c, s) => { location.hash = `#/client-errors/${encodeURIComponent(c)}/${s}`; };
  const cat = h('select', { 'data-testid': 'ce-category', onchange: (e) => go(e.target.value, sort) },
    h('option', { value: '', selected: !category }, 'すべて'),
    // desync first: it is about fairness
    ['desync', 'exception', 'api', 'asset', 'stall'].map((c) => h('option', { value: c, selected: c === category }, `${CATEGORY[c][0]}（${num(data.totals.byCategory[c] ?? 0)}）`)));
  const srt = h('select', { 'data-testid': 'ce-sort', onchange: (e) => go(category, e.target.value) }, Object.entries(SORT).map(([k, v]) => h('option', { value: k, selected: k === sort }, v)));
  mount(main, h('h1', {}, 'クライアントのエラー'),
    h('p', { class: 'muted' }, `端末が送ったエラーを指紋（正規化したスタックのハッシュ）ごとにまとめています。保存は ${data.config.retentionDays} 日・最大 ${num(data.config.maxGroups)} 行。推定の数は抽出率で割り戻した値です。レースのズレは公平さに関わるので、間引かずに届きます。`),
    data.alerts.length
      ? card('通知（新しい指紋の急増）', table([
        { label: '日時', value: (g) => jst(g.alert.at) }, { label: '種類', value: (g) => catBadge(g.category) },
        { label: 'エラー', value: (g) => h('a', { href: `#/client-errors/${encodeURIComponent(category)}/${sort}/${g.fingerprint}` }, g.title) },
        { label: '版', value: (g) => g.alert.appVersion }, { label: '推定', value: (g) => num(g.alert.estimated), class: 'num' },
      ], data.alerts, { testid: 'ce-alerts' }))
      : null,
    h('div', { class: 'row' }, field('種類', cat), field('並び', srt)),
    card(null, table([
      { label: '種類', value: (g) => catBadge(g.category) },
      { label: 'エラー', value: (g) => h('a', { href: `#/client-errors/${encodeURIComponent(category)}/${sort}/${g.fingerprint}`, 'data-testid': `ce-open-${g.fingerprint}` }, g.title) },
      { label: '数', value: (g) => num(g.count), class: 'num' }, { label: '推定', value: (g) => num(g.estimated), class: 'num' },
      { label: '版', value: (g) => versions(g.versions) }, { label: '端末', value: (g) => platforms(g.platforms) },
      { label: '最初', value: (g) => jst(g.firstSeen) }, { label: '最後', value: (g) => jst(g.lastSeen) },
      { label: '', value: (g) => (g.alert ? badge('急増', 'bad') : null) },
    ], data.groups, { empty: '届いたエラーはありません', testid: 'ce-table' })));
}

async function clientErrorDetailView(main, category, sort, fp) {
  const g = await get(`/v1/admin/client-errors/${encodeURIComponent(fp)}`);
  const sampleCols = [
    { label: '日時', value: (s) => jst(s.at) }, { label: '版', value: (s) => s.appVersion }, { label: '端末', value: (s) => `${s.platform} · ${s.deviceModel || '—'} · ${s.osVersion || '—'}` },
    { label: 'プレイヤー', value: (s) => (s.playerId ? h('a', { href: `#/players/${encodeURIComponent(s.playerId)}` }, s.playerId) : h('span', { class: 'muted' }, '匿名')) },
  ];
  if (g.category === 'desync') {
    sampleCols.push({ label: 'レース', value: (s) => (s.race ? h('div', {}, h('div', {}, `${s.race.raceId} · tick ${s.race.tick}`), h('div', { class: 'small muted', 'data-testid': 'ce-replay' }, `リプレイ ${s.race.replay}`)) : '—') });
    sampleCols.push({ label: '検証の結果', value: (s) => (s.race?.integrity ? `${s.race.integrity.status}（記録 ${s.race.integrity.events.length}）` : '—（匿名の見本）') });
  } else if (g.category === 'exception') {
    sampleCols.push({ label: 'メッセージとスタック', value: (s) => h('div', {}, h('div', {}, s.message ?? ''), h('pre', { class: 'json' }, s.stack || '（スタックなし）')) });
  } else {
    sampleCols.push({ label: '中身', value: (s) => h('code', {}, JSON.stringify(s.context)) });
  }
  const byDay = new Map();
  for (const d of g.days) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.count);
  mount(main, h('p', {}, h('a', { href: `#/client-errors/${encodeURIComponent(category)}/${sort}` }, '← クライアントのエラー')),
    h('h1', {}, catBadge(g.category), ' ', g.title),
    card('概要', kv([['指紋', h('code', { 'data-testid': 'ce-fp' }, g.fingerprint)], ['数（推定）', `${num(g.count)}（${num(g.estimated)}）`], ['最初に見た', `${jst(g.firstSeen)}（${g.firstVersion}）`],
      ['最後に見た', `${jst(g.lastSeen)}（${g.lastVersion}）`], ['版', versions(g.versions)], ['端末', platforms(g.platforms)],
      ['通知', g.alert ? `${jst(g.alert.at)} ${g.alert.appVersion} 推定 ${num(g.alert.estimated)}` : 'なし']], 'ce-summary')),
    card('直近 14 日', table([{ label: '日（UTC）', value: (r) => r[0] }, { label: '数', value: (r) => num(r[1]), class: 'num' }], [...byDay.entries()], { empty: 'なし', testid: 'ce-days' })),
    card('見本（新しい順）', table(sampleCols, g.samples, { empty: '見本はありません', testid: 'ce-samples' })));
}
