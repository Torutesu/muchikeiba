import { can, get, getSession, post } from '../api.js';
import { badge, card, confirmWrite, field, h, jst, mount, num, run, statusKind, table } from '../ui.js';
import { grantText } from './players.js';

/** Compensation approvals (REQ-OPS-026): a large grant is paid only after a second, different admin approves it. */
export async function compensationsView(main, [status = 'pending']) {
  const data = await get(`/v1/admin/compensations?status=${encodeURIComponent(status)}&limit=100`);
  const me = getSession()?.id;
  const sel = h('select', { 'data-testid': 'comp-status', onchange: (e) => { location.hash = `#/compensations/${e.target.value}`; } },
    ['pending', 'approved', 'executed', 'rejected', 'expired'].map((s) => h('option', { value: s, selected: s === status }, s)));
  const decide = (c, kind) => async (e) => {
    const approve = kind === 'approve';
    const reason = await confirmWrite({
      title: `${c.id} を${approve ? '承認して付与' : '却下'}`,
      summary: [h('div', {}, `${c.playerId}：${grantText(c.grant)}`), h('div', { class: 'muted small' }, `依頼 ${c.requestedBy}（${jst(c.requestedAt)}）：${c.reason}`)],
      danger: !approve, confirmLabel: approve ? '承認して付与' : '却下',
    });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`/v1/admin/compensations/${encodeURIComponent(c.id)}/${kind}`, { reason }), approve ? '承認し、付与しました' : '却下しました')) compensationsView(main, [status]);
  };
  mount(main, h('h1', {}, '補填の承認'),
    h('p', { class: 'muted' }, `無償コイン ${num(data.threshold.freeCoins)} 枚・1アイテム ${num(data.threshold.itemQty)} 個を超える補填は、依頼者とは別の admin の承認で付与されます（上限 ${num(data.hardCap.freeCoins)} 枚・${num(data.hardCap.itemQty)} 個、72時間で期限切れ）。`),
    h('div', { class: 'row' }, field('状態', sel)),
    card(null, table([
      { label: 'ID', value: (c) => c.id }, { label: '依頼', value: (c) => `${c.requestedBy}（${c.requestedRole}）` }, { label: '日時', value: (c) => jst(c.requestedAt) },
      { label: 'プレイヤー', value: (c) => h('a', { href: `#/players/${encodeURIComponent(c.playerId)}` }, c.playerId) },
      { label: '内容', value: (c) => grantText(c.grant) }, { label: '理由', value: (c) => c.reason },
      { label: '状態', value: (c) => [badge(c.status, statusKind(c.status)), c.error ? badge(`支払い失敗 ${c.error}`, 'bad') : null] },
      { label: '判断', value: (c) => (c.decidedBy ? `${c.decidedBy}（${jst(c.decidedAt)}）` : '—') },
      { label: '期限', value: (c) => (c.status === 'pending' ? jst(c.expiresAt) : '—') },
      { label: '', value: (c) => h('div', { class: 'actions' },
        (c.status === 'pending' || (c.status === 'approved' && c.error)) && can('admin')
          ? h('button', { class: 'btn small primary', 'data-testid': `approve-${c.id}`, disabled: c.requestedBy === me, title: c.requestedBy === me ? '自分の依頼は承認できません（2人ルール）' : '', onclick: decide(c, 'approve') }, c.status === 'approved' ? '支払いを再試行' : '承認') : null,
        c.status === 'pending' && can('operator') ? h('button', { class: 'btn small danger', 'data-testid': `reject-${c.id}`, onclick: decide(c, 'reject') }, '却下') : null) },
    ], data.requests, { empty: '該当する依頼はありません', testid: 'comp-table' })));
}
