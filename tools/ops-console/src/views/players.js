import { can, get, newOpKey, post } from '../api.js';
import { badge, card, confirmWrite, errorBox, field, fromJstInput, h, jst, json, kv, mount, num, run, statusKind, table, toast, yen } from '../ui.js';

const INVITE_RE = /^[23456789BCDFGHJKMNPQRSTVWXZ]{4}-?[23456789BCDFGHJKMNPQRSTVWXZ]{4}$/i;
/** REQ-BOX-010: the titles ops may choose for a gift (server giftBox.ts OPS_TITLE_KEYS). */
const GIFT_TITLES = [['ops_compensation', 'お詫びの品'], ['ops_compensation_maintenance', 'メンテナンスのお詫び'], ['ops_compensation_bug', '不具合のお詫び'], ['ops_grant', '運営からの贈り物']];
const FLAG_LABEL = { gift: 'プレゼントボックス', ads: '広告', invite: '招待の不正', purchase: '購入', social: '支部フィード', support: 'サポート' };

/** Player support (REQ-OPS-020..026, REQ-OPS-033): lookup, wallet, purchases, flags, compensation, ban, deletion. */
export async function playersView(main, [playerId]) {
  const q = h('input', { type: 'search', placeholder: 'プレイヤーID または 招待コード（XXXX-XXXX）', value: playerId ?? '', 'data-testid': 'player-query', autocomplete: 'off', spellcheck: 'false' });
  const out = h('div');
  const search = h('form', { class: 'row search', onsubmit: async (e) => {
    e.preventDefault();
    const v = q.value.trim();
    if (!v) return;
    if (INVITE_RE.test(v)) {
      try { const r = await get(`/v1/admin/players/lookup?inviteCode=${encodeURIComponent(v)}`); location.hash = `#/players/${encodeURIComponent(r.playerId)}`; } catch (err) { mount(out, errorBox(err)); }
    } else location.hash = `#/players/${encodeURIComponent(v)}`;
  } }, q, h('button', { class: 'btn primary', type: 'submit', 'data-testid': 'player-search' }, '検索'));
  mount(main, h('h1', {}, 'プレイヤー サポート'), search, out);
  if (!playerId) {
    const flagged = await get('/v1/admin/integrity/players?status=flagged&limit=50').catch(() => ({ players: [] }));
    mount(out, card('要確認のプレイヤー（不正対策）', table([
      { label: 'ID', value: (p) => h('a', { href: `#/players/${encodeURIComponent(p.playerId)}` }, p.playerId) },
      { label: '状態', value: (p) => badge(p.status, statusKind(p.status)) }, { label: '点数', value: (p) => p.score?.toFixed?.(1) ?? p.score, class: 'num' },
      { label: '更新', value: (p) => jst(p.updatedAt) },
    ], flagged.players, { empty: '該当なし' })));
    return;
  }
  const v = await get(`/v1/admin/players/${encodeURIComponent(playerId)}`);
  mount(out, playerDetail(v, () => playersView(main, [playerId])));
}

function playerDetail(v, reload) {
  const s = v.state;
  const w = s.walletDetail;
  const id = s.id ?? s.playerId;
  const mod = s.moderation?.status ?? v.integrity?.status ?? 'ok';
  const header = h('div', { class: 'player-head', 'data-testid': 'player-head' },
    h('h2', {}, s.profile?.displayName ?? id), h('code', {}, id),
    s.exists === false ? badge(s.accountDeleted ? '削除済みアカウント' : '未登録（データなし）', 'bad') : null,
    badge(mod, statusKind(mod)),
    s.deletion ? badge(`削除: ${s.deletion.status}`, 'warn') : null,
    h('span', { class: 'muted small' }, `作成 ${jst(s.createdAt)}`));

  const wallet = card('財布',
    h('div', { class: 'row' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '有償コイン'), h('div', { class: 'stat-value', 'data-testid': 'wallet-paid' }, num(w.paid))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '無償コイン'), h('div', { class: 'stat-value', 'data-testid': 'wallet-free' }, num(w.free))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '返金負債'), h('div', { class: `stat-value${w.debt ? ' bad' : ''}` }, num(w.debt))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '有償残高（円換算）'), h('div', { class: 'stat-value' }, yen(w.paidBalanceYen))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '今月の支払い'), h('div', { class: 'stat-value' }, yen(s.monthlySpendYen?.[new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7)] ?? 0))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, '年齢帯'), h('div', { class: 'stat-value small' }, s.ageBand ?? '未登録'))),
    h('h3', {}, '有償ロット（先入れ先出し）'),
    table([{ label: 'ロット', value: (l) => l.lotId }, { label: '取引', value: (l) => l.txId }, { label: '付与', value: (l) => num(l.granted), class: 'num' }, { label: '残り', value: (l) => num(l.remaining), class: 'num' }, { label: '単価（円）', value: (l) => (l.unitPriceMicroYen / 1e6).toFixed(3), class: 'num' }, { label: '日時', value: (l) => jst(l.at) }], w.lots, { empty: '有償ロットなし' }),
    Object.keys(w.itemDebt ?? {}).length ? kv(Object.entries(w.itemDebt).map(([k, n]) => [`アイテム負債 ${k}`, String(n)])) : null);

  const purchases = card('購入履歴', table([
    { label: '日時', value: (p) => jst(p.at) }, { label: 'ストア', value: (p) => [p.platform, p.sandbox ? badge('sandbox', 'muted') : null] },
    { label: '商品', value: (p) => p.productId }, { label: '取引ID', value: (p) => h('code', {}, p.txId) },
    { label: '金額', value: (p) => yen(p.priceYen), class: 'num' }, { label: '有償', value: (p) => num(p.paidCoinsGranted), class: 'num' }, { label: 'おまけ', value: (p) => num(p.bonusCoinsGranted), class: 'num' },
    { label: '状態', value: (p) => [p.refunded ? badge('返金', 'bad') : badge('有効', 'ok'), p.limitBreach ? badge('上限超過', 'warn') : null] },
  ], [...(s.purchases ?? [])].reverse(), { empty: '購入なし', testid: 'purchases-table' }));

  const flags = card('サポート用の印', table([
    { label: '種類', value: (f) => badge(FLAG_LABEL[f.group] ?? f.group, f.group === 'support' ? '' : 'warn') },
    { label: '印', value: (f) => h('code', {}, f.kind) }, { label: '詳細', value: (f) => f.detail || '—' },
  ], v.flags ?? [], { empty: '印なし', testid: 'flags-table' }));

  const integ = v.integrity ?? {};
  const integrity = card('不正対策・処分', kv([
    ['状態', badge(integ.status ?? 'ok', statusKind(integ.status ?? 'ok'))], ['点数（7日）', String(integ.score ?? 0)],
    ['隔離期限', jst(integ.quarantinedUntil ?? null)], ['BAN', integ.banned ? `${integ.banned.until ? `${jst(integ.banned.until)} まで` : '無期限'}（${integ.banned.by}：${integ.banned.reason}）` : 'なし'],
  ], 'integrity-kv'), modActions(id, integ, reload),
  integ.notes?.length ? h('details', {}, h('summary', {}, `メモ ${integ.notes.length} 件`), table([{ label: '日時', value: (n) => jst(n.at) }, { label: '操作', value: (n) => n.action }, { label: '担当', value: (n) => n.by }, { label: '理由', value: (n) => n.reason }], [...integ.notes].reverse())) : null);

  const del = s.deletion;
  const deletion = card('アカウント削除', del ? kv([['状態', badge(del.status, 'warn')], ['申請', jst(del.requestedAt)], ['削除予定', jst(del.deleteAt)], ['済んだ手順', del.steps.join(', ') || '—'], ['試行', String(del.attempts)], ['再試行', jst(del.retryAt)]], 'deletion-kv')
    : h('div', { class: 'muted', 'data-testid': 'deletion-kv' }, s.accountDeleted ? '削除済み（データは消去されています）' : '削除の申請なし'));

  const ref = s.referral;
  const referral = card('友達招待', ref ? [
    kv([['招待された', ref.invitedBy ? `${ref.invitedBy.playerId ?? '（削除済み）'}（コード ${ref.invitedBy.code}、${jst(ref.invitedBy.at)}）` : 'なし'], ['端末数', String(ref.installs)]]),
    table([{ label: '招待した人', value: (x) => (x.deleted ? '（削除済み）' : h('a', { href: `#/players/${encodeURIComponent(x.playerId)}` }, x.playerId)) }, { label: '日時', value: (x) => jst(x.at) }, { label: '数える', value: (x) => (x.counted ? 'はい' : 'いいえ') }, { label: '達成', value: (x) => x.milestones, class: 'num' }], ref.invitees, { empty: '招待した人なし' }),
  ] : h('div', { class: 'muted' }, '招待の記録なし'));

  // REQ-BOX-010: the player's gift box (what is waiting, and the latest history with the internal note)
  const gb = s.giftBox ?? { box: [], history: [], badge: { unclaimed: 0, expiringSoon: 0 } };
  const giftCols = [
    { label: 'ID', value: (g) => g.giftId }, { label: '出どころ', value: (g) => badge(g.source, g.source === 'ops_compensation' ? 'warn' : '') },
    { label: '表示', value: (g) => g.title }, { label: '内容', value: (g) => g.lines.join('、') },
    { label: '届いた', value: (g) => jst(g.createdAt) }, { label: '期限', value: (g) => (g.expiresAt === null ? '期限なし' : jst(g.expiresAt)) },
    { label: '状態', value: (g) => [badge(g.status, g.status === 'unclaimed' ? '' : g.status === 'claimed' ? 'ok' : 'muted'), g.held ? badge(`保留 ${g.held.reason}`, 'warn') : null] },
    { label: 'メモ', value: (g) => h('span', { class: 'muted small' }, g.note) },
  ];
  const gifts = card(`プレゼントボックス（未受け取り ${gb.badge.unclaimed} 件${gb.badge.expiringSoon ? `、期限の近いもの ${gb.badge.expiringSoon} 件` : ''}）`,
    h('p', { class: 'muted small' }, '下の「補填…」で入れたものはここに届きます（プレイヤーが受け取るまで財布は変わりません）。有償コインは入りません。'),
    table(giftCols, gb.box, { empty: '未受け取りのプレゼントなし', testid: 'player-gifts' }),
    h('details', {}, h('summary', {}, `履歴（直近 ${gb.history.length} 件）`), table(giftCols, gb.history, { empty: '履歴なし', testid: 'player-gift-history' })));

  const comps = card('補填', compensationForm(id, reload), table([
    { label: 'ID', value: (c) => c.id }, { label: '日時', value: (c) => jst(c.requestedAt) }, { label: '内容', value: (c) => grantText(c.grant) },
    { label: '状態', value: (c) => badge(c.status, statusKind(c.status)) }, { label: '依頼', value: (c) => c.requestedBy }, { label: '承認', value: (c) => c.decidedBy ?? '—' }, { label: '理由', value: (c) => c.reason },
  ], v.compensations ?? [], { empty: '補填の記録なし', testid: 'player-comps' }));

  const ledger = card('台帳（直近100件）', h('details', {}, h('summary', {}, `${s.ledger?.length ?? 0} 件`), table([
    { label: '#', value: (l) => l.seq, class: 'num' }, { label: '日時', value: (l) => jst(l.at) }, { label: '種類', value: (l) => l.kind }, { label: '通貨', value: (l) => l.currency },
    { label: '増減', value: (l) => (l.delta > 0 ? `+${num(l.delta)}` : num(l.delta)), class: 'num' }, { label: '残高', value: (l) => num(l.balanceAfter), class: 'num' }, { label: '理由', value: (l) => l.reason },
  ], [...(s.ledger ?? [])].reverse())));

  return h('div', { class: 'player' }, header, h('div', { class: 'cols' }, wallet, flags), purchases, historyCard(id), devicesCard(id), h('div', { class: 'cols' }, integrity, h('div', {}, deletion, referral)), gifts, comps, ledger,
    h('details', {}, h('summary', {}, '生データ（JSON）'), json(v)));
}

const DEVICE_OS = { ios: 'iOS', android: 'Android', other: 'その他' };
const deviceName = (x) => [x.model, x.platform ? `${DEVICE_OS[x.platform] ?? x.platform}${x.osMajor != null ? ' ' + x.osMajor : ''}` : null].filter(Boolean).join(' / ') || '—';
/**
 * REQ-DEV-017 (contracts/protocol.md §70.7): ログイン中の端末 — the signed-in sessions (coarse labels, country, hour-rounded times;
 * never auth_time or install id hashes) and the security log, for any viewer; signing a session out (one / all) is admin only,
 * with the reason in the audit (player.devices.revoke). Confirm the player's identity through the inquiry first.
 */
function devicesCard(playerId) {
  const out = h('div', { 'data-testid': 'devices-out' }, h('span', { class: 'muted small' }, '読み込み中…'));
  const base = `/v1/admin/players/${encodeURIComponent(playerId)}/devices`;
  const revoke = (label, body, summary) => h('button', { class: 'btn small danger', 'data-testid': body.all ? 'devices-revoke-all' : 'devices-revoke', onclick: async (e) => {
    const reason = await confirmWrite({ title: `${playerId}：${label}`, summary, danger: true, confirmLabel: label });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(`${base}/revoke`, { ...body, reason }), (o) => `${label}：${o.signedOut}台`)) load();
  } }, label);
  const load = async () => {
    try {
      const v = await get(base);
      mount(out,
        table([
          { label: '端末', value: (x) => deviceName(x) }, { label: '版', value: (x) => x.appVersion ?? '—' }, { label: '地域', value: (x) => x.region ?? '—' },
          { label: '最初', value: (x) => jst(x.firstSeenAt) }, { label: '最後', value: (x) => jst(x.lastSeenAt) },
          ...(can('admin') ? [{ label: '', value: (x) => revoke('ログアウト', { sessionId: x.sessionId }, `${deviceName(x)} のセッションを無効にします。次の要求から SESSION_REVOKED。`) }] : []),
        ], v.sessions, { empty: 'セッションの記録なし', testid: 'devices-table' }),
        h('div', { class: 'row' },
          h('span', { class: 'muted small' }, `無効化の記録 ${v.revokedCount} 件・覚えている端末 ${v.knownDevices} 台${v.othersBeforeAt ? `・「すべて」${jst(v.othersBeforeAt)}` : ''}`),
          can('admin') ? revoke('すべてログアウト', { all: true }, '今より前にログインしたすべてのセッションを無効にします（本人の端末も）。本人確認の後に行ってください。') : null),
        h('details', {}, h('summary', {}, `セキュリティの記録（${v.log.length} 件）`), table([
          { label: '日時', value: (x) => jst(x.at) }, { label: '内容', value: (x) => x.text }, { label: '端末', value: (x) => (x.device ? deviceName(x.device) : '—') },
        ], v.log, { empty: '記録なし', testid: 'devices-log' })));
    } catch (err) { mount(out, errorBox(err)); }
  };
  load();
  return card('ログイン中の端末', out);
}

/**
 * REQ-HIST-010 (contracts/protocol.md §33.4): the player's own history screen, read only (every read is in the audit log), with
 * the internal values support needs (store transaction id, raw ledger reason). A 問い合わせ draft's reference numbers
 * (P-… / C-… / G-…) open the rows they point at. Deleted accounts answer 404: their anonymised legal record is never shown here.
 */
const HISTORY_KINDS = [['purchases', '購入'], ['coins:paid', '有償コイン'], ['coins:free', '無償コイン'], ['gacha', 'ガチャ']];
function historyCard(playerId) {
  const base = `/v1/admin/players/${encodeURIComponent(playerId)}/history`;
  const out = h('div', { 'data-testid': 'history-out' });
  const kind = h('select', { 'data-testid': 'history-kind' }, HISTORY_KINDS.map(([k, label]) => h('option', { value: k }, label)));
  const refs = h('input', { type: 'search', placeholder: '問い合わせ番号（P-1A2B3C4D, C-123, G-7）', 'data-testid': 'history-refs', autocomplete: 'off', spellcheck: 'false' });
  const cols = {
    purchases: [{ label: '番号', value: (r) => h('code', {}, r.ref) }, { label: '日時', value: (r) => jst(r.at) }, { label: '商品', value: (r) => r.product }, { label: '金額', value: (r) => yen(r.priceYen), class: 'num' },
      { label: 'ストア', value: (r) => r.storeName }, { label: '状態', value: (r) => badge(r.statusText, r.status === 'refunded' ? 'bad' : r.status === 'pending' ? 'warn' : 'ok') }, { label: '取引ID', value: (r) => h('code', {}, r.internal?.txId ?? '') }],
    coins: [{ label: '番号', value: (r) => h('code', {}, r.ref) }, { label: '日時', value: (r) => jst(r.at) }, { label: '通貨', value: (r) => r.currency }, { label: '増減', value: (r) => (r.direction === 'spent' ? `-${num(r.amount)}` : r.direction === 'earned' ? `+${num(r.amount)}` : '0'), class: 'num' },
      { label: '残高', value: (r) => num(r.balanceAfter), class: 'num' }, { label: '表示', value: (r) => r.title }, { label: '台帳の理由', value: (r) => h('code', {}, r.internal?.reason ?? '') }],
    gacha: [{ label: '番号', value: (r) => h('code', {}, r.ref) }, { label: '日時', value: (r) => jst(r.at) }, { label: 'バナー', value: (r) => r.banner }, { label: '回数', value: (r) => r.count, class: 'num' },
      { label: '有償/無償', value: (r) => `${num(r.coins.paid)} / ${num(r.coins.free)}`, class: 'num' }, { label: '結果', value: (r) => r.summary }],
  };
  const load = async (cursor = null) => {
    const [k, currency] = kind.value.split(':');
    const q = new URLSearchParams({ kind: k, limit: '20', ...(currency ? { currency } : {}), ...(cursor ? { cursor } : {}) });
    try {
      const r = await get(`${base}?${q}`);
      mount(out, table(cols[k], r.items, { empty: '記録なし', testid: 'history-table' }),
        r.nextCursor ? h('button', { class: 'btn small', 'data-testid': 'history-more', onclick: () => load(r.nextCursor) }, '次の20件') : null,
        h('p', { class: 'muted small' }, `直近 ${r.windowDays} 日`));
    } catch (err) { mount(out, errorBox(err)); }
  };
  const lookup = async () => {
    const list = refs.value.split(/[\s,、]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!list.length) return;
    try {
      const r = await get(`${base}?refs=${encodeURIComponent(list.join(','))}`);
      mount(out, table([{ label: '番号', value: (x) => h('code', {}, x.ref) }, { label: '種類', value: (x) => x.kind ?? badge('見つかりません', 'bad') },
        { label: '日時', value: (x) => (x.row ? jst(x.row.at) : '—') }, { label: '内容', value: (x) => (x.row ? json(x.row) : '期間外か、このプレイヤーの記録ではありません') }], r.items, { testid: 'history-refs-table' }));
    } catch (err) { mount(out, errorBox(err)); }
  };
  return card('履歴（本人の画面と同じ・読み取り専用）',
    h('p', { class: 'muted small' }, '購入は法定の保存期間、コインは直近365日、ガチャは直近90日。表示は監査ログに残ります。'),
    h('div', { class: 'row' }, kind, h('button', { class: 'btn small', 'data-testid': 'history-load', onclick: () => load() }, '表示'),
      refs, h('button', { class: 'btn small', 'data-testid': 'history-lookup', onclick: lookup }, '番号で開く')),
    out);
}

export const grantText = (g) => [g.freeCoins ? `無償コイン ${num(g.freeCoins)}` : null, ...(g.items ?? []).map((i) => `${i.itemId} ×${i.qty}`)].filter(Boolean).join('、');

function compensationForm(playerId, reload) {
  if (!can('operator')) return null;
  const coins = h('input', { type: 'number', min: 0, max: 100000, value: 0, 'data-testid': 'comp-coins' });
  const itemId = h('input', { type: 'text', placeholder: 'ticket_sr_plus', pattern: '[a-z0-9_]{1,64}', 'data-testid': 'comp-item' });
  const qty = h('input', { type: 'number', min: 1, max: 1000, value: 1, 'data-testid': 'comp-qty' });
  // REQ-BOX-010: how it shows in the player's gift box (title) and how long it can be received (blank = 90 days)
  const titleKey = h('select', { 'data-testid': 'comp-title' }, ...GIFT_TITLES.map(([k, t]) => h('option', { value: k }, t)));
  const expiry = h('input', { type: 'number', min: 1, max: 365, placeholder: '90', 'data-testid': 'comp-expiry' });
  const noExpiry = h('input', { type: 'checkbox', 'data-testid': 'comp-no-expiry' });
  return h('div', { class: 'comp-form' },
    h('p', { class: 'muted small' }, 'プレイヤーのプレゼントボックスに入ります（受け取りで財布へ）。無償コインとアイテムだけ（有償コインは作れません）。1万コイン・1アイテム100個を超えると、別の admin の承認待ちになります（上限10万コイン・1000個）。'),
    h('div', { class: 'row' }, field('表示（プレゼントボックス）', titleKey), field('受け取り期限（日）', expiry, '空欄＝90日'), field('期限なし', noExpiry)),
    h('div', { class: 'row' }, field('無償コイン', coins), field('アイテムID（任意）', itemId), field('個数', qty),
      h('button', { class: 'btn primary', 'data-testid': 'comp-submit', onclick: async (e) => {
        const grant = {};
        if (Number(coins.value) > 0) grant.freeCoins = Number(coins.value);
        if (itemId.value.trim()) grant.items = [{ itemId: itemId.value.trim(), qty: Number(qty.value) }];
        if (!grant.freeCoins && !grant.items) { toast('配布内容が空です', 'error'); return; }
        const large = (grant.freeCoins ?? 0) > 10000 || (grant.items ?? []).some((i) => i.qty > 100);
        const reason = await confirmWrite({ title: `${playerId} に補填`, summary: [grantText(grant), large ? h('div', { class: 'alert warn' }, '大口のため承認待ちになります（あなた以外の admin が承認するまで付与されません）。') : null], confirmLabel: large ? '承認を依頼' : '付与する' });
        if (!reason) return;
        const gift = { titleKey: titleKey.value, ...(noExpiry.checked ? { expiryDays: null } : expiry.value ? { expiryDays: Number(expiry.value) } : {}) };
        const r = await run(e.currentTarget, () => post('/v1/admin/compensations', { playerId, grant, opKey: newOpKey('comp'), reason, ...gift }), (o) => (o.request.status === 'pending' ? `${o.request.id}：承認待ち` : `${o.request.id}：プレゼントボックスに入れました`));
        if (r) reload();
      } }, '補填…')));
}

function modActions(playerId, integ, reload) {
  const btns = [];
  const act = (label, path, extra, opts = {}) => h('button', { class: `btn small ${opts.danger ? 'danger' : ''}`, 'data-testid': opts.testid, onclick: async (e) => {
    const reason = await confirmWrite({ title: `${playerId}：${label}`, summary: opts.summary ?? '', danger: !!opts.danger, extra: opts.extraNode, confirmLabel: label });
    if (!reason) return;
    if (await run(e.currentTarget, () => post(path, { ...(extra?.() ?? {}), reason }), `${label}：完了`)) reload();
  } }, label);
  const base = `/v1/admin/integrity/players/${encodeURIComponent(playerId)}`;
  if (integ.status === 'quarantined' && can('operator')) btns.push(act('隔離を解除', `${base}/release`, null, { testid: 'release' }));
  if (can('admin')) {
    if (integ.status === 'banned') btns.push(act('BAN 解除', `${base}/unban`, null, { testid: 'unban' }));
    else {
      const until = h('input', { type: 'datetime-local', 'data-testid': 'ban-until' });
      btns.push(act('BAN', `${base}/ban`, () => ({ until: fromJstInput(until.value) }), { danger: true, testid: 'ban', summary: 'ランク戦・フレンド部屋・購入ができなくなります。', extraNode: field('期限（JST、空欄＝無期限）', until) }));
    }
  }
  return btns.length ? h('div', { class: 'actions' }, btns) : null;
}
