import { can, get, newOpKey, post } from '../api.js';
import { badge, card, confirmWrite, field, h, jst, kv, mount, run, table } from '../ui.js';

/**
 * ヘルプセンターの問い合わせ (REQ-HELP-016/017, contracts/protocol.md §48.7). The list is the index (no text); opening a
 * ticket reads it from the player's object (audited); a reply needs a reason and is applied once per opKey.
 * Replies are a person's words in the ticket's language (`lang`): they are never translated for the player.
 */
const STATUS = { received: ['受付済み', 'warn'], answered: ['回答済み', 'ok'], closed: ['完了', 'muted'] };
const CATEGORY = {
  purchase_missing: '購入したのに届かない', refund: '返金', coins: 'コインの増減', gacha: 'スカウトの結果', race: 'レース・ムチ',
  account: 'アカウント・引き継ぎ', deletion: 'アカウント削除', accessibility: 'アクセシビリティ', bug: '不具合', other: 'その他',
};
const statusBadge = (s) => badge(STATUS[s]?.[0] ?? s, STATUS[s]?.[1] ?? '');

export async function inquiriesView(main, [status = 'received', playerId, ticketId]) {
  if (playerId && ticketId) return inquiryDetailView(main, status, playerId, ticketId);
  const data = await get(`/v1/admin/inquiries?status=${encodeURIComponent(status)}&limit=100`);
  const sel = h('select', { 'data-testid': 'inq-status', onchange: (e) => { location.hash = `#/inquiries/${e.target.value}`; } },
    Object.keys(STATUS).map((s) => h('option', { value: s, selected: s === status }, STATUS[s][0])));
  mount(main, h('h1', {}, '問い合わせ'),
    h('p', { class: 'muted' }, '一覧には本文を載せていません（開くとプレイヤーのデータから読み、閲覧は監査ログに残ります）。返信は問い合わせの言語（lang）で書いてください。翻訳はされません。'),
    h('div', { class: 'row' }, field('状態', sel)),
    card(null, table([
      { label: 'ID', value: (r) => h('a', { href: `#/inquiries/${status}/${encodeURIComponent(r.playerId)}/${r.ticketId}`, 'data-testid': `inq-open-${r.ticketId}` }, r.ticketId) },
      { label: 'プレイヤー', value: (r) => h('a', { href: `#/players/${encodeURIComponent(r.playerId)}` }, r.playerId) },
      { label: '種類', value: (r) => CATEGORY[r.category] ?? r.category }, { label: '言語', value: (r) => r.lang },
      { label: '添付', value: (r) => String(r.attachments) }, { label: '受付', value: (r) => jst(r.createdAt) }, { label: '更新', value: (r) => jst(r.updatedAt) },
      { label: '状態', value: (r) => statusBadge(r.status) },
    ], data.items, { empty: '該当する問い合わせはありません', testid: 'inq-table' })));
}

async function inquiryDetailView(main, status, playerId, ticketId) {
  const t = await get(`/v1/admin/players/${encodeURIComponent(playerId)}/inquiries/${encodeURIComponent(ticketId)}`);
  const content = h('textarea', { rows: 6, maxlength: 2000, 'data-testid': 'inq-reply', placeholder: t.lang === 'en' ? 'Reply in English' : '日本語で返信' });
  const close = h('input', { type: 'checkbox', 'data-testid': 'inq-close' });
  const opKey = newOpKey(`reply-${ticketId}`);
  const send = async (e) => {
    if (!content.value.trim()) return;
    const reason = await confirmWrite({ title: `${ticketId} に返信`, summary: [h('div', {}, `${playerId}（${t.lang}）`), h('div', { class: 'muted small' }, content.value.slice(0, 200))], confirmLabel: close.checked ? '返信して完了' : '返信' });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`/v1/admin/players/${encodeURIComponent(playerId)}/inquiries/${encodeURIComponent(ticketId)}/reply`, { opKey, content: content.value, close: close.checked, reason }), '返信しました')) inquiryDetailView(main, status, playerId, ticketId);
  };
  mount(main, h('p', {}, h('a', { href: `#/inquiries/${status}` }, '← 問い合わせ一覧')),
    h('h1', {}, `${ticketId}　`, statusBadge(t.status)),
    card('概要', kv([['プレイヤー', h('a', { href: `#/players/${encodeURIComponent(playerId)}` }, playerId)], ['種類', CATEGORY[t.category] ?? t.category], ['言語', t.lang], ['受付', jst(t.createdAt)],
      ['最初の返信', t.firstReplyAt ? jst(t.firstReplyAt) : '—'], ['置き換えた個人情報', String(t.redacted)]], 'inq-summary')),
    card('本文', h('div', { class: 'pre', 'data-testid': 'inq-text', style: 'white-space: pre-wrap' }, t.inquiryText)),
    card('添えた記録', table([{ label: '番号', value: (a) => a.ref }, { label: '種類', value: (a) => a.kind }, { label: '日時', value: (a) => jst(a.at) }, { label: '内容', value: (a) => `${a.title}　${a.detail}` }],
      t.attachments, { empty: 'なし（番号は プレイヤー サポート → 履歴 で開けます）' })),
    card('診断情報', kv([['アプリの版', t.diagnostics.appVersion], ['端末', t.diagnostics.platform], ['直近のレース', t.diagnostics.lastRaceIds.join(', ') || '—']])),
    card('やりとり', table([{ label: '日時', value: (m) => jst(m.at) }, { label: '送り手', value: (m) => (m.from === 'support' ? `運営（${m.by ?? '—'}）` : 'プレイヤー') }, { label: '内容', value: (m) => h('div', { style: 'white-space: pre-wrap' }, m.messageText) }],
      t.messages, { empty: 'まだ返信していません', testid: 'inq-messages' })),
    t.status !== 'closed' && can('operator')
      ? card('返信', field('内容', content), h('label', { class: 'row' }, close, ' 返信して完了にする'), h('button', { class: 'btn primary', 'data-testid': 'inq-send', onclick: send }, '返信'))
      : null);
}
