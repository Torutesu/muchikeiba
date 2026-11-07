import { can, get, post } from '../api.js';
import { badge, card, confirmWrite, errorBox, field, fromJstInput, h, jst, json, kv, mount, num, run, statusKind, table, toJstInput } from '../ui.js';

const MIN = 60_000;

/** Events and tournaments (REQ-EVENT-*, REQ-TOUR-001/009/010): list, status, mini tournament creation, detail, cancel. */
export async function eventsView(main, [tourId]) {
  const [ev, tours] = await Promise.all([get('/v1/admin/events'), get('/v1/admin/tournaments').catch((e) => ({ error: e }))]);
  const detailOut = h('div', { 'data-testid': 'tournament-detail' });

  const eventsCard = card('イベントレース（有効な設定）', table([
    { label: 'ID', value: (e) => h('code', {}, e.id) }, { label: '名前', value: (e) => e.name },
    { label: '状態', value: (e) => badge(e.status, statusKind(e.status)) },
    { label: '期間', value: (e) => `${jst(e.startAtMs)} 〜 ${jst(e.endAtMs)}` },
    { label: 'コース', value: (e) => e.trackIds.join(', ') },
    { label: '参加費', value: (e) => (e.fee.kind === 'free' ? `無償コイン ${num(e.fee.freeCoins)}` : e.fee.kind === 'item' ? `${e.fee.itemId} ×${e.fee.qty}` : 'なし') },
    { label: '人数', value: (e) => e.maxPlayers, class: 'num' },
  ], ev.events, { empty: 'イベントはありません', testid: 'events-table' }));

  async function showTournament(id) {
    try {
      const d = await get(`/v1/admin/tournaments/${encodeURIComponent(id)}`);
      mount(detailOut, card(`大会 ${id}`,
        kv([['名前', d.name ?? d.def?.name], ['状態', badge(d.status, statusKind(d.status))], ['参加', `${d.entrants ?? Object.keys(d.registrants ?? {}).length}`]]),
        can('operator') && !['finished', 'cancelled'].includes(d.status) ? h('button', { class: 'btn danger small', 'data-testid': 'tournament-cancel', onclick: async (e) => {
          const reason = await confirmWrite({ title: `大会 ${id} を中止`, summary: '表彰前のみ中止できます。賞品は出ません。', danger: true, confirmLabel: '中止する' });
          if (reason && (await run(e.currentTarget, () => post(`/v1/admin/tournaments/${encodeURIComponent(id)}/cancel`, { reason }), '中止しました'))) eventsView(main, [id]);
        } }, '中止…') : null,
        h('details', {}, h('summary', {}, '詳細（JSON）'), json(d))));
    } catch (e) { mount(detailOut, errorBox(e)); }
  }

  const toursCard = card('大会', tours.error ? errorBox(tours.error) : table([
    { label: 'ID', value: (t) => h('a', { href: `#/events/${encodeURIComponent(t.id)}`, 'data-testid': `tour-${t.id}` }, t.id) }, { label: '名前', value: (t) => t.name },
    { label: '状態', value: (t) => badge(t.status, statusKind(t.status)) },
    { label: '受付', value: (t) => `${jst(t.registrationOpensAtMs)} 〜 ${jst(t.registrationClosesAtMs)}` },
    { label: '開始', value: (t) => jst(t.startsAtMs) },
    { label: '参加', value: (t) => `${t.entrants} / ${t.maxEntrants}`, class: 'num' },
  ], tours.tournaments, { empty: '大会はありません', testid: 'tournaments-table' }));

  mount(main, h('h1', {}, 'イベント・大会'), eventsCard, toursCard, detailOut, can('operator') ? createForm(ev.tracks, main) : null);
  if (tourId) showTournament(tourId);
}

/** A mini tournament with sensible defaults (registration open now, closes in 1 h, 4 per heat, 8 runners). */
function createForm(tracks, main) {
  const now = Date.now();
  const id = h('input', { type: 'text', value: `mini_${new Date(now + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')}_${Math.floor(Math.random() * 900 + 100)}`, pattern: '[a-z0-9_]{3,40}', 'data-testid': 't-id' });
  const name = h('input', { type: 'text', maxlength: 40, value: 'ミニ大会', 'data-testid': 't-name' });
  const track = h('select', { 'data-testid': 't-track' }, tracks.map((t) => h('option', { value: t.id }, `${t.id}（${t.surface} ${t.distanceM}m）`)));
  const opens = h('input', { type: 'datetime-local', value: toJstInput(now), 'data-testid': 't-opens' });
  const closes = h('input', { type: 'datetime-local', value: toJstInput(now + 60 * MIN), 'data-testid': 't-closes' });
  const starts = h('input', { type: 'datetime-local', value: toJstInput(now + 65 * MIN), 'data-testid': 't-starts' });
  const n = (v, min, max, testid) => h('input', { type: 'number', value: v, min, max, 'data-testid': testid });
  const heat = n(4, 2, 12, 't-heat'), fieldSize = n(8, 2, 12, 't-field'), adv = n(2, 1, 11, 't-adv'), maxE = n(16, 2, 512, 't-max'), minE = n(2, 2, 512, 't-min');
  const prize = n(500, 0, 100000, 't-prize');
  const out = h('div');
  return card('ミニ大会を作る',
    h('div', { class: 'grid' }, field('ID', id, '英小文字・数字・_'), field('名前', name), field('コース', track),
      field('受付開始（JST）', opens), field('受付締め（JST）', closes), field('開始（JST）', starts),
      field('1組の人数', heat), field('出走頭数（CPU込み）', fieldSize), field('各組の勝ち上がり', adv), field('最大参加', maxE), field('最少参加', minE), field('優勝賞品（無償コイン）', prize)),
    h('button', { class: 'btn primary', 'data-testid': 't-create', onclick: async (e) => {
      const tournament = {
        id: id.value, name: name.value, trackIds: [track.value],
        registrationOpensAtMs: fromJstInput(opens.value), registrationClosesAtMs: fromJstInput(closes.value), startsAtMs: fromJstInput(starts.value),
        heatSize: Number(heat.value), fieldSize: Number(fieldSize.value), advancePerHeat: Number(adv.value), maxEntrants: Number(maxE.value), minEntrants: Number(minE.value),
        prizes: Number(prize.value) > 0 ? [{ maxRank: 1, reward: { freeCoins: Number(prize.value) } }] : [],
      };
      const reason = await confirmWrite({ title: `大会 ${tournament.id} を作成`, summary: `${tournament.name}／${jst(tournament.startsAtMs)} 開始／最大 ${tournament.maxEntrants} 人`, confirmLabel: '作成' });
      if (!reason) return;
      const r = await run(e.currentTarget, () => post('/v1/admin/tournaments', { tournament, reason }), (o) => `大会 ${o.id ?? tournament.id} を作成しました`);
      if (r) location.hash = `#/events/${encodeURIComponent(tournament.id)}`;
      else mount(out);
    } }, '作成…'), out);
}
