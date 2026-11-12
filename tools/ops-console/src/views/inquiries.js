import { can, get, newOpKey, post } from '../api.js';
import { badge, card, confirmWrite, field, h, jst, kv, mount, run, table } from '../ui.js';

/**
 * ヘルプセンターの問い合わせ (REQ-HELP-016/017, contracts/protocol.md §48.7) — Round 23: お問い合わせの状況確認 (REQ-TKT-006..010,
 * §73.6). The queue is the index (no text) with filters (status incl. 返信待ち, category, language, assignee, waiting time),
 * the waiting clock against the SLA and a CSV without text. Opening a ticket reads it from the player's object (audited):
 * the player context, the thread, the internal notes (never shown to the player), the assignee, the status, a reply from
 * a template in the ticket's language, and a link to an existing compensation request. Every write needs a reason and is
 * applied once per opKey. Replies are a person's words in the ticket's language (`lang`): never translated for the player.
 */
const STATUS = {
  open: ['返信待ち（受付済み・確認中）', 'warn'], received: ['受付済み', 'warn'], in_progress: ['確認中', 'warn'], answered: ['返信あり', 'ok'],
  resolved: ['解決', 'muted'], closed: ['クローズ', 'muted'],
};
const CATEGORY = {
  purchase_missing: '購入したのに届かない', refund: '返金', coins: 'コインの増減', gacha: 'スカウトの結果', race: 'レース・ムチ',
  account: 'アカウント・引き継ぎ', deletion: 'アカウント削除', accessibility: 'アクセシビリティ', bug: '不具合', other: 'その他',
};
const AGE = { '': 'すべて', 24: '24時間以上', 48: '48時間以上', 72: '72時間以上' };
const statusBadge = (s) => badge(STATUS[s]?.[0] ?? s, STATUS[s]?.[1] ?? '');
const hours = (ms) => (ms === null || ms === undefined ? '—' : ms < 3_600_000 ? `${Math.max(0, Math.round(ms / 60_000))}分` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}時間` : `${Math.floor(ms / 86_400_000)}日${Math.floor((ms % 86_400_000) / 3_600_000)}時間`);
const waitCell = (r) => (r.waitingMs === null || r.waitingMs === undefined ? '—' : r.slaBreached ? badge(`${hours(r.waitingMs)}（SLA超え）`, 'bad') : hours(r.waitingMs));

/** #/inquiries/<status>?category=&lang=&assignee=&minAgeHours= */
function readFilter(status) {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return { status, category: q.get('category') ?? '', lang: q.get('lang') ?? '', assignee: q.get('assignee') ?? '', minAgeHours: q.get('minAgeHours') ?? '' };
}
const qs = (f, extra = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();

export async function inquiriesView(main, [statusArg = 'open', playerId, ticketId]) {
  const status = (statusArg ?? 'open').split('?')[0];
  if (playerId && ticketId) return inquiryDetailView(main, status, decodeURIComponent(playerId), ticketId.split('?')[0]);
  const f = readFilter(status);
  const data = await get(`/v1/admin/inquiries?${qs(f, { limit: 200 })}`);
  const go = (patch) => { const n = { ...f, ...patch }; location.hash = `#/inquiries/${n.status}?${qs({ ...n, status: '' })}`; };
  const select = (testid, value, options, onchange) => h('select', { 'data-testid': testid, onchange: (e) => onchange(e.target.value) },
    Object.entries(options).map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
  const csv = async (e) => {
    const out = await run(e.currentTarget, () => get(`/v1/admin/inquiries/export?${qs(f)}`), (x) => `CSV ${x.rows}行（本文なし）`);
    if (!out) return;
    const a = h('a', { href: URL.createObjectURL(new Blob([out.csv], { type: 'text/csv' })), download: `inquiries-${f.status}.csv`, 'data-testid': 'inq-csv-link' });
    document.body.appendChild(a); a.click(); a.remove();
    main.dataset.csvRows = String(out.rows);
  };
  mount(main, h('h1', {}, '問い合わせ'),
    h('p', { class: 'muted' }, `一覧には本文を載せていません（開くとプレイヤーのデータから読み、閲覧は監査ログに残ります）。待ち時間が ${data.slaHours ?? 48} 時間を超えたものは赤で示します。返信は問い合わせの言語（lang）で書いてください。翻訳はされません。`),
    h('div', { class: 'row' },
      field('状態', select('inq-status', f.status, Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v[0]])), (v) => go({ status: v }))),
      field('種類', select('inq-category', f.category, { '': 'すべて', ...CATEGORY }, (v) => go({ category: v }))),
      field('言語', select('inq-lang', f.lang, { '': 'すべて', ja: '日本語', en: 'English' }, (v) => go({ lang: v }))),
      field('担当', select('inq-assignee', f.assignee, { '': 'すべて', me: '自分', none: '未割り当て' }, (v) => go({ assignee: v }))),
      field('待ち時間', select('inq-age', f.minAgeHours, AGE, (v) => go({ minAgeHours: v }))),
      h('button', { class: 'btn', 'data-testid': 'inq-csv', onclick: csv }, 'CSV（本文なし）')),
    card(null, table([
      { label: 'ID', value: (r) => h('a', { href: `#/inquiries/${f.status}/${encodeURIComponent(r.playerId)}/${r.ticketId}`, 'data-testid': `inq-open-${r.ticketId}` }, r.ticketId) },
      { label: 'プレイヤー', value: (r) => h('a', { href: `#/players/${encodeURIComponent(r.playerId)}` }, r.playerId) },
      { label: '種類', value: (r) => CATEGORY[r.category] ?? r.category }, { label: '言語', value: (r) => r.lang },
      { label: '添付', value: (r) => String(r.attachments) }, { label: '受付', value: (r) => jst(r.createdAt) }, { label: '更新', value: (r) => jst(r.updatedAt) },
      { label: '待ち時間', value: waitCell }, { label: '担当', value: (r) => r.assignee ?? '—' },
      { label: '状態', value: (r) => statusBadge(r.status) },
    ], data.items, { empty: '該当する問い合わせはありません', testid: 'inq-table' })));
}

async function inquiryDetailView(main, status, playerId, ticketId) {
  const base = `/v1/admin/players/${encodeURIComponent(playerId)}/inquiries/${encodeURIComponent(ticketId)}`;
  const [t, tpl] = await Promise.all([get(base), get(`/v1/admin/inquiry-templates?playerId=${encodeURIComponent(playerId)}&ticketId=${encodeURIComponent(ticketId)}`).catch(() => ({ items: [] }))]);
  const again = () => inquiryDetailView(main, status, playerId, ticketId);
  const content = h('textarea', { rows: 6, maxlength: 2000, 'data-testid': 'inq-reply', placeholder: t.lang === 'en' ? 'Reply in English' : '日本語で返信' });
  const tplSel = h('select', { 'data-testid': 'inq-template', onchange: (e) => { const x = tpl.items.find((i) => i.id === e.target.value); if (x) content.value = x.body; } },
    h('option', { value: '' }, `ひな形（${t.lang === 'en' ? '英語' : '日本語'}）…`), tpl.items.map((x) => h('option', { value: x.id }, x.title)));
  const close = h('input', { type: 'checkbox', 'data-testid': 'inq-close' });
  const opKey = newOpKey(`reply-${ticketId}`);
  const write = async (e, title, path, body, ok, summary = null) => {
    const reason = await confirmWrite({ title, summary: summary ?? h('div', {}, `${playerId}・${ticketId}`) });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`${base}/${path}`, { ...body, reason }), ok)) again();
  };
  const send = async (e) => {
    if (!content.value.trim()) return;
    const reason = await confirmWrite({ title: `${ticketId} に返信`, summary: [h('div', {}, `${playerId}（${t.lang}）`), h('div', { class: 'muted small' }, content.value.slice(0, 200))], confirmLabel: close.checked ? '返信してクローズ' : '返信' });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`${base}/reply`, { opKey, content: content.value, close: close.checked, reason }), '返信しました')) again();
  };
  const note = h('textarea', { rows: 3, maxlength: 1000, 'data-testid': 'inq-note', placeholder: '内部メモ（プレイヤーには見えません）' });
  const comp = h('input', { type: 'text', 'data-testid': 'inq-comp-id', placeholder: '補填の依頼 id（例 comp_12）' });
  const open = t.status !== 'closed';
  const op = can('operator');
  mount(main, h('p', {}, h('a', { href: `#/inquiries/${status}` }, '← 問い合わせ一覧')),
    h('h1', {}, `${ticketId}　`, statusBadge(t.status), t.slaBreached ? h('span', {}, '　', badge(`待ち ${hours(t.waitingMs)}（SLA ${t.slaHours}時間超え）`, 'bad')) : null),
    card('概要', kv([['プレイヤー', h('a', { href: `#/players/${encodeURIComponent(playerId)}` }, playerId)], ['種類', CATEGORY[t.category] ?? t.category], ['言語', t.lang], ['受付', jst(t.createdAt)],
      ['最初の返信', t.firstReplyAt ? jst(t.firstReplyAt) : '—'], ['待ち時間', hours(t.waitingMs)], ['自動クローズ', t.autoCloseAt ? jst(t.autoCloseAt) : '—'], ['再開の期限', t.replyUntil ? jst(t.replyUntil) : '—'],
      ['担当', t.assignee ?? '未割り当て'], ['置き換えた個人情報・秘密', String(t.redacted)]], 'inq-summary')),
    card('プレイヤーの文脈', kv([['アカウント作成', jst(t.player?.createdAt)], ['削除', t.player?.deletion ?? 'なし'], ['制裁', t.player?.moderation ?? 'ok'], ['購入の件数', String(t.player?.purchases ?? 0)],
      ['診断情報', t.shareDiagnostics === false ? '添えない（本人の選択）' : `${t.diagnostics.appVersion ?? '—'} / ${t.diagnostics.platform ?? '—'}`], ['直近のレース', t.diagnostics.lastRaceIds.join(', ') || '—']], 'inq-context')),
    card('本文', h('div', { class: 'pre', 'data-testid': 'inq-text', style: 'white-space: pre-wrap' }, t.inquiryText)),
    card('添えた記録', table([{ label: '番号', value: (a) => a.ref }, { label: '種類', value: (a) => a.kind }, { label: '日時', value: (a) => jst(a.at) }, { label: '内容', value: (a) => `${a.title}　${a.detail}` }],
      t.attachments, { empty: 'なし（番号は プレイヤー サポート → 履歴 で開けます）' })),
    card('やりとり', table([{ label: '日時', value: (m) => jst(m.at) }, { label: '送り手', value: (m) => (m.from === 'support' ? `運営（${m.by ?? '—'}）` : 'プレイヤー') }, { label: '内容', value: (m) => h('div', { style: 'white-space: pre-wrap' }, m.messageText) }],
      t.messages, { empty: 'まだ返信していません', testid: 'inq-messages' })),
    card('お詫びの品（補填）', table([{ label: '補填の依頼', value: (c) => h('a', { href: '#/compensations' }, c.ref) }, { label: '結んだ日時', value: (c) => jst(c.at) }], t.compensation ?? [], { empty: 'なし', testid: 'inq-comp' }),
      h('p', { class: 'muted small' }, 'お詫びは「補填」画面の依頼（二人の確認・上限・プレゼントボックス・理由）だけで配ります。ここではその依頼をこの問い合わせに結ぶだけで、何も配りません。'),
      op && open ? h('div', { class: 'row' }, field('依頼 id', comp), h('button', { class: 'btn', 'data-testid': 'inq-comp-link', onclick: (e) => comp.value.trim() && write(e, '補填を結ぶ', 'compensation', { compensationId: comp.value.trim() }, '結びました') }, '結ぶ')) : null),
    card('内部メモ（プレイヤーには見えません）', table([{ label: '日時', value: (n) => jst(n.at) }, { label: '書いた人', value: (n) => n.by }, { label: 'メモ', value: (n) => h('div', { style: 'white-space: pre-wrap' }, n.text) }],
      t.internalNotes ?? [], { empty: 'メモはありません', testid: 'inq-notes' }),
      op ? h('div', {}, field('メモ', note), h('button', { class: 'btn', 'data-testid': 'inq-note-add', onclick: (e) => note.value.trim() && write(e, '内部メモを足す', 'notes', { opKey: newOpKey(`note-${ticketId}`), text: note.value }, 'メモを足しました') }, 'メモを足す')) : null),
    op ? card('担当・状態',
      h('div', { class: 'row' },
        h('button', { class: 'btn', 'data-testid': 'inq-assign-me', onclick: (e) => write(e, '自分が担当する', 'assign', { assignee: 'me' }, '担当にしました') }, '自分が担当'),
        h('button', { class: 'btn ghost', 'data-testid': 'inq-unassign', onclick: (e) => write(e, '担当を外す', 'assign', { assignee: null }, '担当を外しました') }, '担当を外す')),
      open ? h('div', { class: 'row' },
        ...[['in_progress', '確認中にする'], ['resolved', '解決にする'], ['closed', 'クローズする']].map(([s, label]) =>
          h('button', { class: 'btn', 'data-testid': `inq-status-${s}`, disabled: t.status === s, onclick: (e) => write(e, label, 'status', { opKey: newOpKey(`st-${ticketId}`), status: s }, '状態を変えました') }, label))) : null) : null,
    open && op
      ? card('返信', field('ひな形', tplSel, 'トークンは問い合わせの言語で埋めてあります。送る前に読み直してください。'), field('内容', content), h('label', { class: 'row' }, close, ' 返信してクローズにする'), h('button', { class: 'btn primary', 'data-testid': 'inq-send', onclick: send }, '返信'))
      : null);
}
