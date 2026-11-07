import { get } from '../api.js';
import { badge, card, errorBox, field, h, jst, kv, mount, num, statusKind, table, yen } from '../ui.js';

const DAY = 86_400_000;

/** Gacha calendar (REQ-OPS-027): banners on a game-day timeline, pity groups and carry-over chains, step-up prices, odds preview. */
export async function gachaView(main, [versionArg]) {
  const cfg = await get('/v1/admin/config');
  const versionId = versionArg ?? 'active';
  const cal = await get(`/v1/admin/gacha/calendar?versionId=${encodeURIComponent(versionId)}`);
  const pick = h('select', { 'data-testid': 'gacha-version', onchange: (e) => { location.hash = `#/gacha/${encodeURIComponent(e.target.value)}`; } },
    ['active', 'base', ...cfg.versions.map((v) => v.id)].map((id) => h('option', { value: id, selected: id === versionId }, id === 'active' ? `active（${cfg.active.versionId}）` : id)));
  const oddsOut = h('div', { 'data-testid': 'odds-preview' });

  async function showOdds(bannerId) {
    mount(oddsOut, h('div', { class: 'loading' }, '読み込み中…'));
    try {
      const r = await get(`/v1/admin/gacha/${encodeURIComponent(bannerId)}/odds?versionId=${encodeURIComponent(cal.versionId)}`);
      mount(oddsOut, oddsPage(r.odds));
      oddsOut.scrollIntoView({ block: 'start' });
    } catch (e) { mount(oddsOut, errorBox(e)); }
  }

  mount(main,
    h('h1', {}, 'ガチャ カレンダー'),
    h('div', { class: 'row' }, field('設定の版', pick),
      h('div', { class: 'muted small' }, `今日のゲーム日 ${cal.today}（日替わり ${cal.dayRollover.hourJst}:00 JST${cal.dayRollover.effectiveAtMs > cal.serverNowMs ? `、${jst(cal.dayRollover.effectiveAtMs)} までは ${cal.dayRollover.previousHourJst}:00` : ''}）`)),
    card(`バナー（${cal.versionId}）`, timeline(cal, showOdds), bannerTable(cal, showOdds)),
    card('天井グループと引き継ぎ', pityTable(cal)),
    oddsOut);
}

function timeline(cal, onPick) {
  const dated = cal.banners.filter((b) => b.startAtMs !== null || b.endAtMs !== null);
  const now = cal.serverNowMs;
  const lo = Math.min(now - 7 * DAY, ...dated.map((b) => b.announceAtMs ?? b.startAtMs ?? now));
  const hi = Math.max(now + 21 * DAY, ...dated.map((b) => b.endAtMs ?? now));
  const pct = (t) => `${(((t - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const width = (a, b) => `${Math.max(0.6, ((b - a) / (hi - lo)) * 100).toFixed(2)}%`;
  const ticks = [];
  const step = Math.max(1, Math.round((hi - lo) / DAY / 12)) * DAY;
  for (let t = lo; t <= hi; t += step) ticks.push(h('div', { class: 'tl-tick', style: `left:${pct(t)}` }, jst(t).slice(5, 10)));
  return h('div', { class: 'timeline', 'data-testid': 'gacha-timeline' },
    h('div', { class: 'tl-axis' }, ticks, h('div', { class: 'tl-now', style: `left:${pct(now)}`, title: `now ${jst(now)}` })),
    cal.banners.map((b) => {
      const start = b.startAtMs ?? lo, end = b.endAtMs ?? hi;
      const ann = b.announceAtMs !== null && b.startAtMs !== null ? h('div', { class: 'tl-announce', style: `left:${pct(b.announceAtMs)};width:${width(b.announceAtMs, b.startAtMs)}`, title: `予告 ${jst(b.announceAtMs)}` }) : null;
      return h('div', { class: 'tl-row' },
        h('div', { class: 'tl-label', title: b.id }, b.name),
        h('div', { class: 'tl-track' }, ann,
          h('button', { class: `tl-bar ${b.status}${b.currency === 'paidOnly' ? ' paid' : ''}${b.endAtMs === null ? ' permanent' : ''}`, style: `left:${pct(start)};width:${width(start, end)}`, 'data-testid': `tl-${b.id}`,
            title: `${b.name}\n${b.firstDay ?? '常設'} 〜 ${b.lastDay ?? '常設'}`, onclick: () => onPick(b.id) }, `${b.firstDay ?? ''}${b.lastDay ? ` → ${b.lastDay}` : b.firstDay ? ' →' : '常設'}`)));
    }));
}

function bannerTable(cal, onPick) {
  return table([
    { label: 'ID', value: (b) => h('code', {}, b.id) },
    { label: '名前', value: (b) => b.name },
    { label: '状態', value: (b) => badge(b.status, statusKind(b.status)) },
    { label: '期間（ゲーム日）', value: (b) => (b.firstDay || b.lastDay ? `${b.firstDay ?? '—'} 〜 ${b.lastDay ?? '常設'}` : '常設') },
    { label: '予告', value: (b) => jst(b.announceAtMs) },
    { label: '通貨', value: (b) => (b.currency === 'paidOnly' ? badge('有償のみ', 'warn') : 'any') },
    { label: '価格', value: (b) => (b.stepUp ? h('span', {}, 'ステップ: ', b.stepUp.prices.map((p, i) => h('span', { class: `step${b.stepUp.finalSlotSteps.includes(i + 1) ? ' final' : ''}`, title: b.stepUp.finalSlotSteps.includes(i + 1) ? '10枠目の専用表あり' : '' }, num(p))), ` (${b.stepUp.afterLast})`) : `単発 ${num(b.priceSingle)} / 10連 ${num(b.priceTen)}`), class: 'nowrap' },
    { label: '天井', value: (b) => `${b.pityLabel}（${b.pityCost ?? '—'}回）` },
    { label: 'ピックアップ', value: (b) => (b.pickup ? `${b.pickup.name}（${b.pickup.rarity}）` : '—') },
    { label: '', value: (b) => h('button', { class: 'btn small', 'data-testid': `odds-${b.id}`, onclick: () => onPick(b.id) }, '提供割合') },
  ], cal.banners, { testid: 'banner-table' });
}

function pityTable(cal) {
  return table([
    { label: 'グループ', value: (g) => h('code', {}, g.id) }, { label: '表示名', value: (g) => g.label },
    { label: '天井', value: (g) => `${g.cost}回` },
    { label: '締め', value: (g) => (g.endAtMs ? `${g.lastDay}（${jst(g.endAtMs)}）` : '締めなし') },
    { label: '引き継ぎの流れ', value: (g) => h('span', { class: 'chain', 'data-testid': `chain-${g.id}` }, g.chain.map((c, i) => [i ? h('span', { class: 'arrow' }, ' → ') : null, h('code', {}, c)])) },
    { label: 'バナー', value: (g) => g.banners.join(', ') || '—' },
    { label: 'プレイヤーへの表示', value: (g) => (g.carryOver ? h('small', {}, g.carryOver.notice) : '—') },
  ], cal.pityGroups, { testid: 'pity-table' });
}

/** The odds page with the same fields and wording the app shows (GET /v1/gacha/:bannerId/odds). */
function oddsPage(o) {
  const rows = (items) => table([
    { label: '馬', value: (r) => [r.name, r.limited ? badge(r.limited.label, 'warn') : null] },
    { label: 'レア', value: (r) => r.rarity }, { label: '提供割合', value: (r) => r.rate, class: 'num' },
    { label: 'スキル', value: (r) => (r.skill ? r.skill.name ?? r.skill.id ?? '' : '') },
  ], items ?? []);
  const totals = (t) => (t ? h('div', { class: 'totals' }, Object.entries(t).map(([k, v]) => h('span', { class: 'total' }, `${k} ${v.rate}`))) : null);
  return card(`提供割合プレビュー：${o.name}`,
    h('p', { class: 'muted small' }, 'プレイヤーが見る提供割合ページと同じデータ（同じ関数で生成）です。公開前・終了後のバナーも表示できます。'),
    kv([
      ['バナー', o.bannerId], ['通貨', o.currency], ['価格', `単発 ${num(o.priceSingle)} / 10連 ${num(o.priceTen)}`],
      ['期間', `${jst(o.period.startAtMs)} 〜 ${jst(o.period.endAtMs)}${o.period.lastDay ? `（最終日 ${o.period.lastDay}）` : ''}`],
      ['天井', `${o.pity.label}：${o.pity.pullsRequired}回 / ${num(o.pity.costCoins)}コイン（最大 約${yen(o.pity.estimatedMaxCostYen)}）`],
      o.pickup ? ['ピックアップ', `${o.pickup.name}（${o.pickup.rarity}） ${o.pickup.rate}（10枠目保証 ${o.pickup.guaranteeRate}）`] : null,
    ], 'odds-kv'),
    o.limitedNotice ? h('div', { class: 'alert warn' }, o.limitedNotice) : null,
    o.pity.carryOver ? h('div', { class: 'alert' }, o.pity.carryOver.notice) : null,
    h('h3', {}, '提供割合'), totals(o.rarityTotals), rows(o.items),
    h('h3', {}, '10枠目の保証'), h('p', { class: 'small' }, o.guarantee.appliesTo), totals(o.guarantee.rarityTotals), rows(o.guarantee.items),
    o.stepUp ? [h('h3', {}, 'ステップアップ'), h('p', { class: 'small' }, o.stepUp.notice),
      table([{ label: 'ステップ', value: (s) => s.step }, { label: '10連の価格', value: (s) => num(s.priceTen), class: 'num' }, { label: '10枠目', value: (s) => s.finalSlot.appliesTo }], o.stepUp.steps, { testid: 'stepup-table' })] : null,
    o.tickets?.length ? [h('h3', {}, '使えるチケット'), h('ul', {}, o.tickets.map((t) => h('li', {}, `${t.name}：${t.notice}`)))] : null);
}
